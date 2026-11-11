# Smart Inbox: autorizzazione persistente e comando unico

**Prima**: `prepara` -> `valuta_piano` -> il modello decideva se chiamare `applica`; creare cartelle richiedeva sempre la finestra locale.
**Ora**: con l'autorizzazione attiva il *codice* applica i piani autorizzati subito dopo `prepara` (se non servono valutazioni semantiche) o `valuta_piano`. Il modello riporta l'esito (`applicato`, `esito`, `inSospeso`).

## Concedere e revocare (solo file dell'host, `ORBIT_SMART_INBOX_AMBITO`)
- `autoApplica: true` accende; `false` o chiave assente revoca (riavvio di Orbit). Spenta di default.
- `autoOperazioni` (facoltativo): sottoinsieme di `create`, `append` (MERGE conservativo), `create_dir`. Default `["create","append"]`; `create_dir` e opt-in.
- `autoCartelle` (facoltativo): cartelle (dentro `autorizzati`) in cui si salta la finestra. Default: tutte le `autorizzati`.
- Il modello non puo cambiarle: non passano da testo, parametri o note.

## Controlli al momento della scrittura (tre livelli, nessuno bypassato)
1. `integrations/smartinbox`: applica solo se nessuna decisione e CONFIRM/BLOCK e `cli.autorizzato()` (spec ricalcolata dal piano) rispetta le regole. Un solo tentativo per piano; errore/timeout = `applicato:false, daVerificare:true`, niente riscrittura (usare `stato`/`recupera`).
2. `cli.run`: stessa funzione `additivo` con le regole, altrimenti finestra locale.
3. Bridge `cli-host.ps1` (`-AutoOps`, `-AutoFolders`): ripete il controllo; se Node e piu permissivo il bridge rifiuta (`HOST_CONFIRMATION_REQUIRED`).
Restano invariati Safe Writer, hash/manifest (il file `MANIFEST.sha256` del repo e rigenerato; **il pin operativo del lanciatore va aggiornato dall'utente**), backup/journal/RECOVER, concorrenza.

## Ancora conferma (finestra locale / domanda all'utente)
CONFIRM e BLOCK, operazioni fuori da `autoOperazioni`/`autoCartelle`, archiviazione, recupero, piu di 20 note, note > 256 KiB.

## Limite noto
Applicazione parziale (note sicure + note ambigue nello stesso piano) **non implementata**: `writer.prepara` rifiuta ogni piano con CONFIRM/BLOCK; servirebbe pianificare un sottoinsieme di sorgenti. In quel caso nulla viene scritto e `inSospeso` elenca cosa chiedere. La revoca richiede il riavvio.

## Test
`orbit/tests/smart-inbox-auto.test.js` (sintetici) e `smart-inbox/tests/e2e-auto.cjs` (13, bridge pwsh 7.6.7 reale, vault temporanei).

## Audit, esiti indeterminati, note ostili
- **Audit**: `prepara`/`valuta_piano` restano `lettura` (preparazione); se applicano, il registry registra anche un evento `applicazione_automatica` di livello `modifica` (`eventiAudit`), con stato e codice. Un timeout di uno strumento che puo scrivere e registrato come "esito indeterminato".
- **Indeterminato**: errore, timeout, annullo o esito diverso da APPLIED lasciano l'applicazione "sospesa". Prima di qualsiasi nuova applicazione automatica il codice chiama `status` (sola ispezione): solo con piano completo o non iniziato riprende; altrimenti risposta `SOSPESA / ESITO_PRECEDENTE_INDETERMINATO` e nessuna scrittura. `applica` rifiuta i piani gia tentati. Lo stato sospeso e in memoria: dopo un riavvio un nuovo `prepara` vede NOOP (gia applicato) o CONFIRM (nome gia presente), e il journal dell'Engine protegge le scritture.
- **Note ostili** (test sintetici): chiavi di autorizzazione inventate nelle valutazioni sono respinte dal CLI; hash alterati danno BLOCK; un bersaglio fuori da `autoCartelle` non si applica da solo; l'append contiene solo testo della sorgente. Il testo di una nota non tocca mai le regole (vengono dalla config dell'host).
- **Rischio residuo dell'append automatico**: una nota puo influenzare la valutazione del modello su un candidato simile gia proposto dal codice, ottenendo un MERGE conservativo (solo il proprio testo, con backup) dentro `autoCartelle`. Non e dimostrabile che il modello non venga mai indotto a ritenere equivalente un candidato sbagliato. **Raccomandazione per l'attivazione iniziale sul vault reale: `"autoOperazioni": ["create"]`** (append e create_dir solo dopo la conferma locale), poi allargare con esperienza.
- **Una applicazione alla volta**: un solo `inCorso` per integrazione (copre anche la promessa rimasta viva dopo un timeout); le richieste sovrapposte ricevono `SOSPESA / APPLICAZIONE_IN_CORSO` e solo chi ha impostato la sospensione puo toglierla. Un piano gia tentato risponde `GIA_TENTATO`.
- **Audit**: se `prepara`/`valuta_piano` va in timeout o annullo durante l apply, non esiste un evento `applicazione_automatica`: resta la riga `prepara` (lettura) con "timeout: esito indeterminato" (solo per TIMEOUT/ANNULLATA).

## Valutazione semantica: contratto dei testi e limiti (correzione del bug «tutte ASSENZA_NON_DIMOSTRATA»)
- **Limiti di confronto**: per dimostrare l'assenza ogni nota del catalogo va confrontata. Il CLI ora offre fino a 20 note e 60000 caratteri per sorgente (massimi del planner; prima 8 note e 24000). Con un catalogo piu grande il motivo e `CATALOGO_OLTRE_I_LIMITI_DI_CONFRONTO` (limite vero), non un generico `ASSENZA_NON_DIMOSTRATA`.
- **Testi completi**: `materiale` consegna ogni nota a parti (≤4500 caratteri, dentro il limite dei risultati); l'orchestratore le legge tutte (tetto 16000 caratteri per nota, oltre il quale il testo e dichiarato tagliato e «distinta» non vale). I candidati ripetuti tra sorgenti sono inviati una volta (`uguale_a`).
- **Risposta del modello**: l'array JSON viene estratto anche con testo o blocchi di codice attorno.
- **Motivo reale**: se la valutazione non riesce (nessun modello, testi illeggibili, risposta non valida, valuta_piano rifiutato) il motivo arriva al modello finale e il piano resta com'e.
- Test: `smart-inbox/tests/e2e-valutazione.cjs` (modello finto onesto, catalogo da 13 note come il vault reale; fallisce senza la correzione) e `e2e-modello-reale.cjs` (modello reale, dati sintetici).

## Confronti a lotti (nessun tetto di 20 note)
- **Strategia**: il planner divide l'intero catalogo in **lotti globali** stabili (ordine per percorso; al massimo 16 note e 30000 caratteri per lotto, una nota piu grande sta da sola; massimo 12 lotti, circa 190 note). Ogni sorgente e confrontata con ogni lotto. CREATE solo con tutti i lotti valutati e tutte le relazioni «distinta»; un lotto mancante, parziale o incerto lascia CONFIRM (VALUTAZIONE_PARZIALE / ASSENZA_NON_DIMOSTRATA). Un duplicato in qualunque lotto (anche l'ultimo) non produce mai CREATE. Oltre i 12 lotti: CATALOGO_OLTRE_I_LIMITI_DI_CONFRONTO, senza chiamate al modello.
- **Orchestratore**: una chiamata al modello per lotto, con i soli testi di quel lotto (ogni candidato una volta, anche se serve a piu sorgenti). `valuta_piano` si chiama una volta, a copertura completa.
- **Stato**: le relazioni verificate (equivalente/distinta, mai incerta) si conservano in memoria del processo per coppia di hash (modello + hash sorgente + hash candidato): una richiesta ripetuta, o dopo un errore/annullo/budget, riparte dai lotti mancanti senza rifare i confronti. Si perde al riavvio di Orbit.
- **Testi lunghi**: letti a parti fino a 24000 caratteri per nota; oltre, la coppia resta «incerta» senza nemmeno chiederla (motivo dichiarato: nota X piu lunga di 24000 caratteri). Mai «distinta» su un testo tagliato o illeggibile.
- **Errori**: nessun modello, testo illeggibile (con il codice reale), risposta non valida, valuta_piano rifiutato, budget di token, annullo: nessuna scrittura, il motivo e il lotto arrivano al modello finale e al verificatore.
- **Prompt di lotto**: i candidati compaiono una sola volta (indice j) e ogni sorgente porta solo le coppie da valutare (`salta` per quelle troncate o gia verificate): il prompt cresce con le note, non con sorgenti x note.
- **Costo e tempi misurati con Claude Code reale** (sonnet, 4 sorgenti, dati sintetici): un lotto di ~14 note (~31000 caratteri) = ~18000 token in ingresso + ~1200 in uscita, 5-10 s. 21 note: 2 lotti, 1 richiesta, ~41 s. 50 note: 4 lotti, 200 confronti, ~65000 token in ingresso + ~4700 in uscita; **con il budget predefinito di 60000 token per richiesta servono 3 richieste** (128 s totali; i lotti gia valutati si conservano) perche la risposta finale e il controllo qualita richiedono circa 20000 token; **con `ORBIT_BUDGET_TOKENS_REQUEST=150000` e `ORBIT_BUDGET_TOKENS_ATTEMPT=40000` basta 1 richiesta (51 s)**. Cambiare quei valori e una decisione dell'utente (file .env), non e stato toccato.
- **Costo strutturale**: ogni nuova sorgente va confrontata con tutto il catalogo; si riduce solo con la memoria dei confronti gia fatti, non con un filtro che escluda candidati senza garanzie.
- **Limiti residui**: note del catalogo oltre 24000 caratteri impediscono il CREATE; memoria dei confronti solo in-process; prima valutazione di cataloghi grandi su piu richieste.
