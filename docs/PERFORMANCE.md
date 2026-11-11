# Prestazioni: modalità tradizionale e modalità persistente di Claude

Questo documento descrive come Orbit parla con Claude Code, perché esiste una modalità "persistente" e come si usa o si disattiva. È scritto per essere letto anche da altri agenti (Codex incluso). **Stato al 13 ottobre 2026: la modalità persistente è il comportamento predefinito di Orbit** (autorizzata dall'utente dopo due validazioni reali, 27 chiamate in tutto). **Eccezione: le richieste con ricerca web vanno direttamente sul sistema tradizionale**, senza tentare prima il persistente. La modalità tradizionale resta selezionabile con la sola configurazione (`ORBIT_CLAUDE_MODALITA=tradizionale`, vedi sezione 8, rollback).

## 1. Le due modalità

**Tradizionale (predefinita).** A ogni chiamata a un modello Orbit lancia un processo nuovo `claude -p` (adapter `orbit/ai/providers/claude-code.js`), gli passa il prompt da stdin, legge il JSON finale e il processo termina. Ogni chiamata è indipendente: la cronologia della conversazione viene riscritta nel prompt (`<conversazione_precedente>`), il Quality Gate e la ricerca web sono chiamate separate. Costo fisso per chiamata: avvio di Claude Code e attesa di un riepilogo che Claude Code produce dopo ogni turno (misurati insieme: circa 3 s su un prompt da circa 4.000 token).

**Persistente (predefinita, web escluso).** Adapter `orbit/ai/providers/claude-persistente.js`. Per ogni modello (e per le richieste web) Orbit tiene già pronto un processo `claude` avviato in modalità `stream-json`. Quando arriva una chiamata il messaggio viene scritto sul suo stdin, la risposta si legge in streaming e il processo viene scartato. Il sostituto parte **appena il processo prende il turno** (sostituzione anticipata), così è già pronto quando la risposta arriva e la chiamata successiva (per esempio il verificatore dello stesso modello) lo trova subito. Il costo di avvio esce dal percorso critico.

La differenza non cambia nulla per il resto di Orbit: router, Quality Gate, strumenti, memoria e permessi chiamano lo stesso contratto `ModelExecutionProvider` e non sanno quale modalità sta lavorando.

## 2. Protocollo (verificato su Claude Code 2.1.296)

- **Avvio:** `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <alias> --tools "" (oppure WebSearch,WebFetch) --permission-mode dontAsk --setting-sources user --no-session-persistence --strict-mcp-config --system-prompt <breve>`. Sono gli stessi argomenti di sicurezza della modalità tradizionale: nessuno strumento (solo WebSearch e WebFetch per la ricerca web), nessun MCP, cartella di lavoro neutra fuori dal vault, ambiente ripulito da `ANTHROPIC_*` e simili. Mai `--bare`, mai API a pagamento.
- **Ingresso:** una riga JSON per turno, `{"type":"user","message":{"role":"user","content":"..."}}`.
- **Fine della risposta:** il primo evento `stream_event` di tipo `message_stop`, preceduto da `message_delta` con `stop_reason` uguale a `end_turn` (oppure `max_tokens`, `stop_sequence`); `message_delta` porta anche i token finali. Qualsiasi altro `stop_reason` (per esempio `tool_use`), un secondo messaggio nello stesso turno, una riga non JSON o un `result` senza fine messaggio sono "protocollo non valido".
- **Evento `result`:** arriva circa 2 s dopo la fine della risposta, per il riepilogo post-turno. Orbit non lo aspetta per rispondere (è il guadagno principale) e lo usa solo per contare i turni extra.
- **Primo output:** l'evento `message_start` dà il tempo al primo output, che la modalità tradizionale non può misurare.
- **Il processo non emette nulla finché non riceve il primo messaggio.** Può essere usato subito dopo l'avvio (anche a 0,3 s risponde in circa 1,5 s), ma dà il massimo dopo circa 1,5 s di riscaldamento.

## 3. Isolamento delle sessioni

Un processo serve **un solo turno alla volta** e nessun contenuto passa da una richiesta all'altra.

- **Riuso 1 (predefinito, "monouso").** Dopo aver consegnato la risposta il processo viene terminato e ne parte uno nuovo e pulito. L'isolamento è garantito per costruzione: ogni richiesta parla con un processo che non ha mai visto altro. La cronologia della conversazione continua a viaggiare nel prompt, come oggi.
- **Riuso N (opzione `ORBIT_CLAUDE_RIUSO`).** Dopo la risposta si aspetta `result`, si invia `/clear` e il processo si riusa; dopo N turni si sostituisce. `/clear` funziona solo con i comandi slash attivi, quindi in questa opzione il processo parte senza `--disable-slash-commands`. Per questo Orbit antepone `Testo: ` a qualsiasi prompt che cominci con `/`, in modo che nessun testo dell'utente possa diventare un comando. Misurato con Claude reale: dopo `/clear` il modello non ricordava la parola segreta di prima. Svantaggio misurato: il processo torna disponibile dopo circa 2,6 s (attesa di `result` più `/clear`), più lentamente di un processo nuovo già pronto. Per questo il riuso non è il valore predefinito.
- **Richieste concorrenti.** Ogni chiave (modello) ha al massimo `ORBIT_CLAUDE_POOL` processi (predefinito 2). Se nessuno è libero la chiamata usa **subito** il sistema tradizionale (nessuna coda, nessun mescolamento di output, nessuna attesa). Un processo appena creato è già utilizzabile (accetta il messaggio subito, anche a 0,3 s risponde in circa 1,5 s contro i circa 6 s del tradizionale): non si aspetta mai un processo "in inizializzazione" prima di usarlo. Il sostituto si crea solo se per quel modello non ce n'è già uno libero, quindi non nascono processi doppi.
- **Il Quality Gate non cambia.** Verificatore e candidato restano chiamate separate, con il loro prompt, e non entrano mai nella conversazione di un altro processo.

## 4. Configurazione

Un solo punto di scelta: `orbit/config.js` legge le variabili (il valore predefinito è la costante `MODALITA_CLAUDE_PREDEFINITA`), `orbit/ai/providers/index.js` crea il provider.

| Variabile | Valori | Predefinito | Significato |
| :-- | :-- | :-- | :-- |
| `ORBIT_CLAUDE_MODALITA` | `tradizionale`, `persistente` | `persistente` | modalità attiva; un valore sconosciuto vale `tradizionale` (sicuro) |
| `ORBIT_CLAUDE_RIUSO` | 1 a 100 | 1 | turni per processo (1 = monouso) |
| `ORBIT_CLAUDE_POOL` | 1 a 4 | 2 | processi per modello |
| `ORBIT_CLAUDE_PREWARM` | elenco di modelli, per esempio `haiku,sonnet` | `haiku,sonnet` | processi tenuti pronti all'avvio |
| `ORBIT_CLAUDE_WEB_PERSISTENTE` | `1` | non impostata | sperimentale: ricerca web su processi persistenti. **Non usare**: non validata (sezione 7) |
| `ORBIT_CLAUDE_TTL_MS` | millisecondi | 600000 | un processo fermo più a lungo viene chiuso e non rimpiazzato |

Il router sceglie Haiku, Sonnet o Opus come prima: se non c'è un processo pronto per quel modello (per esempio Opus, usato di rado) la chiamata va in modalità tradizionale e il processo viene preparato per la volta dopo. Scegli il pre-riscaldamento in base ai modelli che usi davvero: nel benchmark la domanda semplice è finita su Sonnet, quindi tenere pronto solo Haiku non serve a niente.

## 5. Gestione dei processi e fallback

- **Avvio di Orbit:** appena il provider viene creato (all'avvio del backend) controlla il login e prepara il pool, senza aspettare che il browser carichi l'interfaccia (`ORBIT_CLAUDE_AVVIO_AUTOMATICO=0` per non farlo).
- **Pre-riscaldamento:** si aggancia al controllo del login (`claude auth status`), che fanno l'interfaccia e l'orchestratore prima delle richieste: se il login dell'abbonamento claude.ai non c'è non si avvia nulla; se c'è si tiene pronto un processo per modello del pre-riscaldamento (mai più di uno libero per modello). Succede anche dopo un'inattività lunga: la richiesta che arriva dopo il TTL trova già un processo appena creato, che risponde in circa 1,5 s.
- **Chiusura:** `chiudi()` e gestori di uscita (`exit`, SIGINT, SIGTERM, SIGHUP) terminano tutti i processi con `taskkill /T`. Se Orbit muore senza gestori, i processi figli escono comunque alla chiusura di stdin. Dopo la chiusura il provider usa solo la modalità tradizionale.
- **Inattività:** dopo `ORBIT_CLAUDE_TTL_MS` un processo fermo si chiude e non viene rimpiazzato: la richiesta successiva usa la modalità tradizionale e riscalda di nuovo.
- **Fallback tradizionale, una sola volta per chiamata**, solo per guasti del processo: nessun processo libero, processo non pronto o morto prima della risposta, protocollo non valido. La chiamata è di sola lettura (strumenti spenti, oppure solo WebSearch e WebFetch), quindi ripeterla non può produrre effetti esterni.
- **Mai ripetuti:** timeout, annullamento, limiti dell'abbonamento, errori del modello. Un timeout o un annullamento uccidono il processo (non si può interrompere un turno a metà) e lo sostituiscono.
- **Interruttore:** dopo 3 guasti di fila la modalità persistente si sospende per 5 minuti e si usa solo la tradizionale: niente cicli di avvio e morte.
- **Turni nascosti:** se un turno contiene più di un turno del modello (`num_turns` maggiore di 1) viene contato in `statistiche.turniExtra`; nei test e nel benchmark reale vale 0.

`provider.stato()` restituisce modalità, processi, stati e statistiche (`persistente`, `tradizionale`, `fallback`, `nessunWorker`, `caduti`, `protocollo`, `timeout`, `turniExtra`, `avviati`).

## 6. Risultati (13 ottobre 2026)

Tutte le misure sono su Claude Code 2.1.296, account Pro, nessun vault, nessuno strumento con effetti esterni. Le due validazioni hanno usato 11 + 16 = 27 chiamate reali. Le etichette: **misurato** = dato reale, **simulato** = test con un falso `claude`, **stima** = ragionamento non misurato.

### 6.1 Prima validazione (provider, Haiku, prompt da circa 4.160 token con testo diverso a ogni chiamata, modalità alternate) - misurato

| | Tradizionale (n=3) | Persistente (n=2) |
| :-- | :-: | :-: |
| Risposta completa | 6,2 / 6,7 / 7,3 s, mediana 6,7 s | 1,5 / 2,1 s |
| Primo output | non misurabile | 0,8 e 1,3 s |
| Avvio di Claude (totale meno durata interna) | 2,9 a 3,6 s | fuori dal percorso critico |
| Token in ingresso | 4.158 a 4.162 | 4.159 e 4.162 |

Richiesta Orbit completa su Sonnet (n=1 per modalità): tradizionale 5,9 s, persistente 1,8 s. Isolamento con `/clear` (riuso 3): la seconda richiesta non conosceva la parola della prima, il processo è tornato disponibile dopo circa 2,6 s.

### 6.2 Seconda validazione (pipeline Orbit completa, router e Quality Gate veri) - misurato

**Tre richieste consecutive nella stessa conversazione** (stessi prompt, stessi modelli scelti dal router: Sonnet, Haiku, Haiku). Latenza totale di Orbit:

| Turno | Tradizionale | Persistente | Primo output (persistente) |
| :-- | :-: | :-: | :-: |
| 1 (Sonnet) | 6,4 s | 1,7 s | 0,79 s |
| 2 (Haiku) | 5,9 s | 2,1 s | 0,78 s |
| 3 (Haiku) | 3,3 s | 1,6 s | 0,76 s |
| Media | 5,2 s | 1,8 s | |

I turni ravvicinati non rallentano: tutti e tre i turni persistenti hanno trovato un processo pronto (età al momento dell'uso: 2,1 s per il turno 3, cioè il sostituto creato all'inizio del turno 2). Token in ingresso a parità di prompt: 1.749 contro 1.748, 1.625 contro 1.618, 1.633 contro 1.630. In ogni richiesta una sola chiamata al modello, Quality Gate PASS, nessuna escalation, nessun retry. Nota: al turno 3 sia il tradizionale sia il persistente hanno risposto di non vedere il numero dei turni precedenti: è il comportamento attuale del passaggio della cronologia in Orbit, identico nelle due modalità, non una conseguenza della persistenza.

**Dopo 4 minuti di inattività** (processi fermi): 1,9 s, in persistente, con un processo vecchio di 260 s. **Isolamento tra conversazioni:** una nuova conversazione che chiedeva "il numero di prima" ha risposto "Non lo so." (1,0 s).

**Ricerca web con Quality Gate** (stessa richiesta nelle due modalità): **il confronto non è valido**. La richiesta tradizionale è fallita 4 volte su 4 con l'errore di Claude Code "Failed to refresh OAuth token: another Claude Code process is refreshing it" (un errore transitorio di login, probabilmente per le altre sessioni di Claude Code aperte sul computer) e Orbit ha **scalato Haiku, Sonnet, Opus** sullo stesso errore, spendendo 4 chiamate per niente. La richiesta persistente è riuscita in 42,6 s con 4 fonti e verifica PASS, ma la parte web è finita sul sistema tradizionale (sotto), quindi non dimostra un guadagno sul web.

**Problema trovato sul web persistente:** il processo persistente con strumenti web ha restituito "protocollo non valido" (probabile causa, non verificata: un turno con ricerca web contiene più messaggi e uno finisce con `tool_use`, mentre il protocollo accetta un solo messaggio per turno). Il fallback ha funzionato (la richiesta ha avuto risposta corretta), ma ha ripetuto la chiamata web: 1 chiamata in più. Correzione: le richieste web restano sul sistema tradizionale finché non sono validate (`ORBIT_CLAUDE_WEB_PERSISTENTE=1` le riattiva, sperimentale); il motivo dell'ultimo protocollo non valido viene ora conservato per la diagnosi. La correzione è verificata solo con test simulati.

**Disponibilità del processo sostitutivo:** il processo esiste dopo 5-33 ms dalla creazione (`spawnMs`) e accetta subito il messaggio. Con la sostituzione anticipata il sostituto parte all'inizio del turno, non alla fine; nelle 7 chiamate persistenti della seconda validazione nessuna ha trovato "nessun processo libero".

**RAM e CPU:** 3 processi pronti (Haiku, Sonnet, Sonnet con web) occupavano 185-203 MB ciascuno, circa 560-610 MB in totale; dopo 240 s di inattività 186-189 MB ciascuno e meno di 1 s di CPU in più. All'avvio ogni processo usa circa 1,5-2,5 s di CPU.

**Chiamate:** 16 su 16. Richiesta web tradizionale 4 (tutte fallite per l'errore di login), richiesta web persistente 4 (1 tentativo web persistente, 1 web tradizionale di fallback, produttore, verificatore), tre turni persistenti 3, tre turni tradizionali 3, inattività 1, isolamento 1. Fallback reali: 1. Retry: 0. Escalation: 3, tutte sul solo errore di login della richiesta tradizionale.

### 6.3 Il caso dei 9,9 s - analisi

Nel primo benchmark la richiesta B2 (subito dopo B1, stesso modello) ha usato il sistema tradizionale in 9,9 s. Cause trovate: (1) il sostituto veniva creato con un timer a 0 ms dopo la consegna della risposta, e lo script di misura aveva appena bloccato il ciclo eventi con una lettura sincrona della RAM, quindi al momento di B2 non esisteva nessun processo; (2) in quel momento si stava avviando anche il sostituto, quindi il tradizionale correva in concorrenza con un avvio (CPU contesa), da qui i 9,9 s. Non c'era nessuna attesa di un processo "in inizializzazione": un processo appena creato è già utilizzabile. Correzione: il sostituto parte all'inizio del turno e, quando un processo muore, subito (nessun timer), solo se per quel modello non ce n'è già uno libero. Test di regressione (simulati): due richieste ravvicinate sono entrambe persistenti; un processo ancora in avvio viene usato senza avviarne altri e senza risposte doppie; senza nessun processo la richiesta passa subito al tradizionale senza superare il pool; 6 richieste concorrenti producono 6 esecuzioni e mai più di 2 processi vivi. Nella seconda validazione (reale) il caso non si è ripresentato in 7 chiamate persistenti, ma un caso non osservato non è una prova.

### 6.4 Test simulati (falso `claude`, nessun consumo)

28 test del provider: riuso e processi distinti, risposte associate alla richiesta, cronologia non mescolata (anche con `/clear`), un solo processo con i modelli giusti, nessuna chiave API nell'ambiente, comando slash non eseguibile, annullamento, timeout senza ripetizione, crash con una sola ripetizione, protocollo non valido e `tool_use`, limite abbonamento non ripetuto, turni nascosti contati, interruttore dopo guasti, inattività oltre il TTL, chiusura ordinata e all'uscita del processo, concorrenza senza duplicati, web escluso. Suite completa: 345 su 345 (in sequenza e in parallelo).

## 7. Limiti conosciuti e problemi aperti

**Problemi aperti (da trattare con lavori dedicati):**
1. **Protocollo non valido con strumenti web.** Il processo persistente con strumenti web (`WebSearch`, `WebFetch`) ha restituito "protocollo non valido" in una richiesta reale; la causa probabile (non verificata) è che un turno con ricerca web contiene più messaggi e uno finisce con `tool_use`. Per questo le richieste web vanno direttamente sul tradizionale (nessun tentativo persistente seguito da ripetizione). `ORBIT_CLAUDE_WEB_PERSISTENTE=1` esiste solo come opzione sperimentale e **non va usata**. Il motivo dell'ultimo protocollo non valido si legge in `provider.ultimoMotivoProtocollo`.
2. **Escalation inappropriata sugli errori OAuth.** Su un errore transitorio di login di Claude Code ("Failed to refresh OAuth token: another Claude Code process is refreshing it") Orbit ha scalato Haiku, Sonnet, Opus sullo stesso errore: 4 chiamate in una richiesta, tutte inutili. Non dipende dalla persistenza (è successo nel tradizionale) ed è una politica di escalation della pipeline, non toccata.
3. **Validazione dedicata del web persistente** ancora da fare: servono gli eventi reali di un turno con ricerca web e il supporto ai turni con più messaggi. Fino ad allora non esiste alcun confronto valido sul web (la richiesta tradizionale di confronto era fallita per l'errore OAuth).

**Limiti del benchmark:**
- Campioni piccoli (n=2 e n=3 per modalità): niente P95, i risultati sono ordini di grandezza. Il confronto sui tre turni consecutivi è su una sola conversazione.
- Non misurati con Claude reale: Opus, conversazioni più lunghe, concorrenza vera su più conversazioni, inattività oltre il TTL (10 minuti), processo Claude che muore davvero. Sono coperti da test simulati.
- La cronologia dei turni (al terzo turno Orbit non vedeva il numero scelto prima) è identica nelle due modalità: comportamento attuale, da verificare a parte.
- Il tetto di output del processo persistente è fisso (16.384 token) invece di variare per chiamata; la brevità si chiede nel prompt, come nel tradizionale.
- `costoEquivalente` non è riportato in modalità persistente.
- Dipende dal formato degli eventi di Claude Code 2.1.296: dopo un aggiornamento va riprovata con una prova reale (i test automatici usano un falso `claude`).
- RAM: circa 200 MB per processo pronto; con il pre-riscaldamento predefinito (Haiku e Sonnet) circa 400 MB sempre occupati, fino a circa 800 MB con il pool pieno.

## 8. Configurazione predefinita e rollback

- **Predefinita:** modalità persistente, pool di 2 processi per modello, pre-riscaldamento di Haiku e Sonnet, sostituzione anticipata, nessun riuso con `/clear`, fallback tradizionale attivo, web sul tradizionale. Il valore predefinito sta in un solo punto: la costante `MODALITA_CLAUDE_PREDEFINITA` in `orbit/config.js`.
- **Rollback immediato, senza toccare il codice né annullare il merge:** impostare `ORBIT_CLAUDE_MODALITA=tradizionale` (nell'ambiente di Windows oppure nel file di profilo di Orbit, per esempio `privato/orbit.env`) e riavviare Orbit (`avvia-orbit.bat`). Dal riavvio ogni chiamata torna a `claude -p` come prima, nessun processo `claude` resta in attesa. Nessun dato, conversazione o file dipende dalla modalità.
- **Rollback automatico parziale:** ogni guasto di un processo passa al tradizionale una volta; dopo 3 guasti di fila la persistenza si sospende per 5 minuti.
- **Rollback di codice (solo se servisse):** `git revert` dei commit del branch `claude/claude-persistente` oppure ripristino di `main` al commit precedente al merge (indicato nel report finale); non serve se la configurazione basta.
- **Come verificare la modalità attiva:** all'avvio il log mostra il provider; `provider.stato().modalita` e le statistiche (`persistente`, `tradizionale`, `fallback`) dicono quante chiamate sono andate in ciascuna modalità.

### Ciclo di vita: i processi vivono solo mentre Orbit è in esecuzione

- **Chi è "Orbit":** il backend `node server.js`, avviato da `avvia-orbit.bat` (collegamento `Orbit.lnk` sul Desktop) nella finestra di console. Il browser è solo un'interfaccia: chiudere la scheda, perdere la connessione o mettere l'interfaccia in background **non** ferma il backend né il pool, e non interrompe richieste in corso.
- **Quando si chiude la finestra di console** (o Orbit esce, o Ctrl+C, o arresto/logout di Windows): i gestori `exit`, SIGINT, SIGTERM e SIGHUP terminano tutti i processi `claude` del pool (e i loro figli). Provato con processi reali: server e processi del pool terminati entro 4 secondi dalla chiusura della finestra.
- **Se il backend viene ucciso a forza** (nessun gestore): i processi `claude` leggono dallo standard input del backend e escono da soli entro circa 1 secondo (provato con processi reali).
- **Mai altri processi:** Orbit termina solo i PID che ha creato e solo se sono ancora suoi figli vivi (nessun rischio di colpire un PID riusato). Le sessioni di Claude Code, Codex e altri programmi non vengono toccate.
- **Riapertura:** il pool si ricrea automaticamente all'avvio, dopo la verifica del login.

## 9. Come si ripete il benchmark

Lo script di misura non fa parte del repository (consuma l'abbonamento). Il metodo: stessi prompt con un identificatore casuale in testa, modalità alternate, contatore che si ferma al tetto autorizzato su ogni chiamata (messaggio inviato a un processo persistente oppure processo `claude -p` avviato), RAM e CPU letti con PowerShell in modo asincrono (una lettura sincrona blocca il ciclo eventi e falsa le misure, vedi 6.3). Chiedere sempre il permesso all'utente prima di rilanciarlo.

## 10. Fase 1 Codex: tracing e risposta immediata

Il tracing è attivo per impostazione predefinita. `ORBIT_TRACE=0` e riavvio del backend lo disattivano anche nel frontend. Non avvia modelli, non scrive nuove tabelle e conserva al massimo gli ultimi 500 turni in RAM, con un massimo di 256 eventi per turno. I dati si perdono al riavvio: è una diagnostica locale leggera, non un archivio storico.

Ogni turno mantiene l'identificatore `req_…` già generato dal backend. Le chiamate al provider aggiungono un numero di chiamata distinto, ruolo e tentativo; questo distingue produttore, verificatore, ricerca web, retry ed escalation anche con richieste concorrenti. Il frontend collega il proprio campione a quell'identificatore quando riceve il finale. Anche Piper riceve l'identificatore quando la lettura è automatica di una risposta PASS.

Le durate nuove usano `performance.now()` nel processo Node o nel browser. Gli eventi backend sono relativi alla ricezione HTTP; i punti frontend sono relativi all'invio o all'ultimo frame vocale rilevato. **Non si sottraggono orologi di processi diversi.** Per distinguere il backend dal frontend si confrontano durate locali: `backend`, invio-primo contenuto, invio-risposta completa e ricezione-primo contenuto. Non si deduce una latenza di rete sottraendo backend e browser.

| Passaggio | Misura disponibile |
| :-- | :-- |
| Ricezione, classificazione, contesto e routing | Marker backend monotoni; il contesto include preparazione e letture del profilo |
| Retrieval Obsidian | Inizio/fine del blocco di letture in ContextBuilder, senza cambiare l'algoritmo |
| Strumenti | Inizio/fine per chiamata; solo il tipo di passaggio entra nel tracing |
| Modello disponibile | `processo_scelto`; il pool attuale non attende: se manca un worker passa subito al tradizionale |
| Primo output persistente | `message_start`; `primo_testo` distingue il primo delta testuale non vuoto |
| Primo output tradizionale | Primo blocco stdout ricevuto: JSON finale, non primo token della generazione |
| Generazione e Quality Gate | Fine generazione, inizio/fine verifica, chiamate con ruolo e tentativo, retry ed escalation |
| Backend pronto | Dopo salvataggio della risposta/diagnostica, prima del finale SSE |
| Frontend | Invio, ricezione finale, risposta PASS osservata, DOM e opportunità di paint con contenuto visibile |
| Voce | Ultimo frame rilevato dal VAD, trascrizione ricevuta, invio AI, PASS, richiesta sintesi, `playing`, fine riproduzione completa |

**Precisione della voce:** i motori Whisper, Vosk e Piper restano invariati. La fine trascrizione è osservata quando il browser riceve il risultato Whisper, quindi comprende il ritorno HTTP. `sintesi_inizio` segna l'invocazione del servizio Piper, includendo eventuale coda interna, non il primo campione generato dal motore. `audio_primo` usa `playing` per Piper o `onstart` per la sintesi browser; non misura la latenza del driver o dell'altoparlante. Uno stop o un errore non vengono registrati come riproduzione completata. La dettatura browser di ripiego non fornisce un marker Whisper.

**Privacy:** il nuovo collector accetta esclusivamente fasi, categorie e ruoli prefissati e valori numerici finiti. Non conserva messaggi, risposte, titoli o percorsi delle note, URL, motivi liberi, credenziali, token o audio. La cronologia e la diagnostica preesistenti restano separate; non viene bonificato retroattivamente il database precedente.

### Consultazione

- `GET /api/performance`: media, mediana, minimo, massimo e numero di campioni per conversazione, memoria, strumenti, web e voce. P95 disponibile da 20 campioni per metrica, altrimenti `null`; una metrica assente non diventa zero.
- `GET /api/performance/req_<id>`: eventi backend e punti frontend di un turno conservato.
- `POST /api/performance/req_<id>`: riceve dal browser solo punti numerici consentiti. Richiede la protezione locale `X-Orbit: 1`, valida l'ordine dei tempi e non permette di sovrascrivere misure già ricevute.
- Gli aggregati includono solo turni PASS o di chiarimento; errori e risposte non approvate restano consultabili nelle tracce, senza entrare nelle medie. Un campione frontend mancante non entra nel relativo denominatore. Le categorie hanno precedenza voce, web, strumenti, memoria, conversazione: ogni turno appartiene a una categoria.

Il paint è osservato dopo due callback di animazione e una verifica di visibilità. È una stima dell'opportunità di disegno del browser, non una misura dei pixel del monitor. Le schede in background e risposte già chiuse non producono un falso campione di visibilità. La risposta completa coincide con il primo paint: tutto il contenuto verificato è già renderizzato, senza streaming o maschere di rivelazione. Non si aspetta la fine della trasformazione del nucleo.

### Reattività e benchmark senza consumo

Eliminate la coda degli stati con tenuta minima di 450 ms e la condizione che aspettava il rientro della rete. La risposta usa subito le dimensioni finali e resta visibile mentre il disco e il nucleo si trasformano; chiusura, movimento ridotto, indicatori e badge di verifica restano operativi. Eventi finali ripetuti o un errore di connessione dopo il finale non aggiungono una seconda risposta.

Per ripetere il confronto simulato, esportare una copia immutata di `main` con `git archive` e poi eseguire:

```powershell
node orbit/tools/bench-performance.js --baseline risultati/base-main
```

Il comando non usa modelli né motori vocali. Su 30 campioni identici con clock simulato: ritardo della coda per inserire la risposta **1.350 ms prima, 0 ms dopo**. Il primo paint simulato a 60 Hz è osservato dopo circa 33 ms. Una prova nel browser con backend finto ha misurato circa 21 ms dalla ricezione al contenuto visibile (n=1, senza P95). Il microbenchmark locale del solo collector con 20 eventi per turno ha misurato circa 0,003 ms medi per turno: non include rete, storage o rendering. Questi numeri non sono benchmark reali di Claude e non sostituiscono una futura prova autorizzata.
