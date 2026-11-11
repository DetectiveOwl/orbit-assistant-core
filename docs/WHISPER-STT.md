# Riconoscimento vocale locale di Orbit (Whisper Small + parola «Orbit»)

Documento permanente per Claude Code e Codex. Ultimo aggiornamento: 12 ottobre 2026.

## Configurazione attuale

**Modello STT principale:** Whisper **Small multilingue** (non la variante solo inglese), file `ggml-small-q8_0.bin`. È il modello Small quantizzato a 8 bit: precisione praticamente uguale al modello pieno, metà della memoria. È l'unico modello in uso e non esiste nessun ripiego automatico.

**Motore di inferenza:** `whisper.cpp` v1.9.2, binari ufficiali Windows x64 (`whisper-server.exe`, backend CPU con selezione automatica delle istruzioni del processore: ad esempio `ggml-cpu-alderlake` sul PC di sviluppo, AVX2/AVX-VNNI). Non usa CUDA, che qui non c'è, né la GPU integrata. Un solo processo per Orbit, avviato in background, con il modello caricato una volta e riusato. Ascolta solo su `127.0.0.1`, su una porta libera scelta all'avvio.

**Parola di attivazione:** Vosk 0.3.45 con il modello italiano piccolo `vosk-model-small-it-0.22` (Kaldi), in un processo Python separato. È leggero (circa un decimo del tempo reale) e indipendente da Whisper.

**Percorsi** (fuori dal vault e fuori dal repository; nessun modello nel codice):

| Cosa | Dove |
| :-- | :-- |
| Binari whisper.cpp | `%LOCALAPPDATA%\Orbit\stt\whisper\` |
| Modello Whisper | `%LOCALAPPDATA%\Orbit\stt\modelli\ggml-small-q8_0.bin` |
| Ambiente Python per Vosk | `%LOCALAPPDATA%\Orbit\stt\venv\` |
| Modello Vosk | `%LOCALAPPDATA%\Orbit\stt\vosk\vosk-model-small-it-0.22\` |
| Processo Whisper in corso | `%LOCALAPPDATA%\Orbit\stt\whisper.pid` (serve a chiudere un processo rimasto da un avvio interrotto) |

**Configurazione centralizzata:** si trova in `orbit/config.js`, sotto `settings.stt`, e si cambia dal file `%LOCALAPPDATA%\Orbit\.env`. Le variabili sono elencate in `orbit/.env.example`.

| Variabile | Predefinito | Significato |
| :-- | :-- | :-- |
| `ORBIT_STT_MOTORE` | `whisper` | `whisper` = locale. `browser` = vecchio riconoscimento di Chrome, che invia l'audio a Google; resta solo come scelta esplicita |
| `ORBIT_STT_MODELLO` | `small` | `small` oppure `base` (vedi "Possibile fallback futuro") |
| `ORBIT_STT_LINGUA` | `it` | lingua della trascrizione (`it`, `en`... oppure `auto`) |
| `ORBIT_STT_THREADS` | `6` | thread di whisper.cpp. Sul PC di sviluppo (18 thread logici) 6 e 8 danno risultati simili, 4 è più lento |
| `ORBIT_STT_CONTESTO` | `3` | finestra audio di Whisper in multipli della durata del parlato (`0` = finestra piena di 30 s) |
| `ORBIT_STT_PAROLA` | `orbit` | parola di attivazione (varianti separate da virgola) |
| `ORBIT_STT_VARIANTI` | vuoto | grafie che Vosk può dare a «Orbit» (per esempio `orbita`); contano solo come prima parola della frase, per non scattare quando si parla di orbite. Da aggiungere dopo aver misurato cosa restituisce Vosk sulla tua voce |
| `ORBIT_STT_DIAGNOSTICA` | `0` | con `1` la console mostra, per ogni comando, il testo grezzo di Whisper con durata, affidabilita e latenza. Contiene quello che dici: spegnila dopo le prove |
| `ORBIT_STT_DIAGNOSTICA_DIR` | vuoto | solo con `ORBIT_STT_DIAGNOSTICA=1`: salva in questa cartella gli ultimi 10 comandi ricevuti (`cmd-<timestamp>.wav`) per riascoltarli con altre impostazioni. Sono registrazioni della tua voce: cancella la cartella a fine prova |
| `ORBIT_STT_PROMPT` | vuoto | vocabolario di partenza per Whisper (massimo 200 caratteri). **Spento di default**: con il prompt «Orbit, assistente personale. Italiano.», su una registrazione reale di 19 s con tre frasi, Whisper si è fermato dopo la prima e ha perso il resto. Il guadagno misurato su voce sintetica va riprovato su più registrazioni reali prima di riattivarlo. Se Whisper ripete il prompt invece di trascrivere, il testo viene scartato |

**Misure su prompt e contesto** (voce sintetica Piper, 20 frasi: non sono misure sul microfono dell'utente):

| Contesto (`ORBIT_STT_CONTESTO`) | WER frasi pulite senza prompt | WER con prompt | Latenza mediana senza prompt |
|---|---|---|---|
| 3 | 35,0 | 35,9 | 2,2 s |
| 5 | 31,7 | 31,7 | 3,6 s |
| 0 (finestra piena) | 29,2 | 25,0 | 5,3 s |

«Orbit» a inizio frase riconosciuto: 64% senza prompt, 91% con prompt a contesto 3 (costo circa 0,2 s). La finestra piena toglie circa 6 punti di WER ma costa circa 2 s. Il guadagno del prompt è però misurato solo su voce sintetica e su una registrazione reale di 19 s con tre frasi ha troncato il comando dopo la prima frase: per questo il prompt resta spento di default (contesto 3; alzare a 5 resta un'opzione).

**Audio e VAD** (nel browser, `orbit/public/voice.js`):
- **Cattura:** `getUserMedia` con cancellazione dell'eco, riduzione del rumore del browser; il guadagno automatico è spento perché saturava (picco al 100% del fondo scala con due microfoni diversi): se il microfono risulta troppo basso, alza il volume d'ingresso di Windows. Con la diagnostica accesa la riga di ogni comando riporta picco, RMS massimo (% del fondo scala) e campioni a ±32767. L'audio arriva a 16 kHz mono, 16 bit, in frame da 20 ms: il contesto audio viene creato a 16 kHz, così il ricampionamento lo fa il browser con un filtro vero; se non è possibile resta la media sui campioni.
- **VAD:** a energia. Il rumore di fondo è il minimo recente (scende in fretta, sale piano sui frame senza parlato), il parlato scatta 9 dB sopra e finisce 6 dB sopra (isteresi), con un minimo assoluto di -52 dBFS. Se il livello resta alto e quasi costante per 4 s non è parlato ma rumore (ventola, ronzio, guadagno del microfono): la stima si ricalibra e il silenzio torna rilevabile. Prima del 18 ottobre 2026 questa ricalibrazione non c'era: con un fondo sopra circa -51 dBFS il VAD restava su "parlato" fino al tetto di 20 o 60 s (ORB-B0010).
- **Fine del comando:** almeno 250 ms di parlato dopo «Orbit» (la coda della parola, entro 0,25 s dalla sua fine stimata, non conta) e poi 1 s di silenzio. A Whisper arriva solo il comando, con 300 ms di margine prima e dopo; la pausa tra «Orbit» e il comando non viene inviata. Nella dettatura con il pulsante del microfono il silenzio richiesto è di 1,2 s.
- **Limiti:** 20 s per un comando dopo «Orbit», 60 s per la dettatura. Se dopo «Orbit» non arriva parlato entro 8 s, si torna in attesa.
- **Filtri:** sotto 0,35 s non si trascrive. Una trascrizione vuota, fatta solo di frasi tipiche dei sottotitoli ("[Musica]", "Sottotitoli a cura di..."), o con fiducia molto bassa (logprob medio sotto -1,2) non viene inviata a Orbit.

**Funzionamento della parola «Orbit»:**
1. Si attiva da sola all'avvio, se la preferenza "Parola Orbit" è accesa, come prima.
2. In attesa, il browser manda a Vosk solo i pezzi di audio con un suono, più 300 ms prima e 600 ms dopo, a pacchetti di circa 250 ms. In silenzio non manda nulla e Whisper non lavora mai.
3. Quando Vosk riconosce «Orbit» restituisce l'istante in cui la parola finisce. Il comando parte da 0,2 s prima di quel punto, recuperato dal buffer degli ultimi 6 s: «Orbit, cosa devo fare oggi?» detto senza pausa arriva intero. L'eventuale resto della parola ("Orbit", "bit") lo toglie `pulisciComando`.
4. Il browser e Vosk restano allineati: ogni risposta di `/api/voce/ascolta` dice quanti campioni Vosk ha ricevuto (`campioni`) e il browser corregge la differenza se un pacchetto è andato perso o Vosk è ripartito da zero (si spegne dopo 10 minuti senza audio). Se Vosk non risponde entro 5 s, il processo viene riavviato.
5. Dopo la pausa finale il comando va a Whisper. Se la trascrizione è vuota o poco affidabile compare il messaggio "Non ho sentito niente" o "Non ho capito bene", come nella dettatura. Il testo trascritto entra nella stessa pipeline dei messaggi digitati (`invia(testo, true)` in `app.js`), con router, memoria e Quality Gate invariati.
6. Mentre Orbit lavora o parla, il microfono si chiude (stati `pausa`). Quando Orbit ha finito, l'interfaccia riprende l'ascolto (`riprendi`).

Stati e callback (`spento`, `attesa`, `attivata`, `pausa`, `errore`; `onAttivata`, `onComando`, `onTesto`, `onErrore`) sono gli stessi del vecchio motore, quindi `app.js` non è cambiato.

**Avvio del servizio STT:** non serve nessun comando. All'apertura, l'interfaccia chiede `GET /api/voce/stato`, e questa prima richiesta avvia in background Whisper (circa 1 s) e Vosk (1-2 s) senza ritardare l'apertura di Orbit. Le richieste che arrivano prima aspettano il caricamento. Il processo Vosk si spegne dopo 10 minuti senza audio. Entrambi i processi si chiudono con Orbit.

**File principali:**

| File | Ruolo |
| :-- | :-- |
| `orbit/public/voice.js` | Microfono, VAD, logica della parola e della dettatura; sceglie il motore (`creaRiconoscimento`, `creaParolaDiAttivazione`) |
| `orbit/voice/whisper.js` | Processo whisper.cpp, trascrizione, filtri, misure |
| `orbit/voice/parola.js`, `orbit/voice/vosk_parola.py` | Parola di attivazione con Vosk |
| `orbit/voice/voce-locale.js` | Rotte `/api/voce/stato`, `ascolta`, `azzera`, `trascrivi` |
| `orbit/app.js`, `orbit/server.js` | Composizione (`app.voce`) e una riga che inoltra `/api/voce/*` |
| `orbit/config.js`, `orbit/.env.example` | Configurazione |
| `orbit/tools/installa-stt.js` | Installazione |
| `orbit/tools/prova-stt.js` | Diagnostica con i motori veri |
| `orbit/tests/stt.test.js` | Test automatici (falsi motori e microfono simulato) |

**Installazione e aggiornamento.** Una volta sola, da `.orbit-hud`:

```
node orbit/tools/installa-stt.js
```

Scarica whisper.cpp da GitHub (`ggml-org/whisper.cpp`) e il modello da Hugging Face (`ggerganov/whisper.cpp`), entrambi con verifica SHA-256. Installa poi Vosk da PyPI in un ambiente Python dedicato, perché serve Python 3.8 o superiore (sul PC c'è la 3.12), e scarica il modello Vosk da alphacephei.com, con la dimensione verificata. Totale circa 320 MB. Ripeterlo non riscarica nulla. Dopo l'installazione tutto funziona senza Internet.

Per aggiornare whisper.cpp:
1. Cambiare in `installa-stt.js` l'URL, la dimensione e lo SHA-256 della versione nuova.
2. Cancellare `%LOCALAPPDATA%\Orbit\stt\whisper\`.
3. Rilanciare l'installatore.

## Diagnostica

```
node orbit/tools/prova-stt.js            (frasi italiane generate con la voce locale Piper)
node orbit/tools/prova-stt.js a.wav b.wav --json
```

Senza microfono, la prova:
1. carica i modelli e ne misura il tempo e la memoria;
2. controlla che in attesa Whisper non consumi CPU;
3. passa ogni campione a Vosk a pacchetti, come fa il browser, e verifica se scatta «Orbit»;
4. taglia il comando come in `voice.js` e lo trascrive.

Per ogni campione riporta:
- **latenza della trascrizione** (`latenzaMs`): dalla richiesta a whisper-server alla risposta;
- **durata dell'audio** (`audioComandoS`);
- **RTF**: tempo di elaborazione diviso per la durata dell'audio. Sotto 1 è più veloce del tempo reale;
- **CPU** consumata da Whisper per quella trascrizione (`cpuWhisperMs`, somma su tutti i thread) e **RAM** del processo (`ramMB`);
- **testo** ottenuto, da confrontare con quello atteso per gli errori di riconoscimento.

In uso reale ogni trascrizione aggiorna `stt.ultima` in `GET /api/voce/stato`, con durata, latenza, RTF e finestra usata. CPU e RAM si leggono anche da Gestione attività (processi `whisper-server.exe` e `python.exe`).

Riferimento misurato il 12 ottobre 2026 su questo PC (Small q8_0, 6 thread, finestra x3), con le frasi di Piper:
- caricamento del modello 0,6-1,2 s; RAM 367 MB a riposo e 390-480 MB durante la trascrizione;
- comandi di 2-3 s: 0,7-2,0 s di latenza; frase di 8 s: 4,7-7,8 s;
- RTF da 0,33 a circa 0,9 a seconda del carico della macchina.

## Possibile fallback futuro

**Attenzione (18 ottobre 2026).** Il passaggio a Base ha senso solo se il problema è la **velocità**. Se il problema è l'**accuratezza** (ORB-B0008), Base è meno preciso di Small e peggiorerebbe le cose: in quel caso il confronto va fatto verso l'alto (per esempio medium o large-v3-turbo quantizzati), sulle registrazioni vere dell'utente, dopo aver escluso le cause a monte (VAD, taglio del comando, qualità dell'audio catturato). Vedi `/mnt/project-files/voce-trascrizione/PIANO-TRASCRIZIONE-VOCALE.md`.

**Regola.** Se in una futura conversazione l'utente riferisce a Claude Code o Codex che Whisper Small è troppo lento, presenta ritardi eccessivi oppure rende poco reattivo Orbit, consultare questo documento e proporre come prima alternativa **Whisper Base multilingue**. Prima di cambiare modello, confrontare le prestazioni di Small e Base sul PC dell'utente, considerando sia latenza sia accuratezza. Se Base è più adatto, spiegare il compromesso e proporre la modifica minima per utilizzarlo. **Non sostituire automaticamente Small senza il consenso dell'utente.** Il passaggio deve conservare wake word, VAD, interfaccia, pipeline AI e tutte le altre funzionalità vocali.

**Come confrontare:**
1. `node orbit/tools/installa-stt.js --modello base`, che scarica solo `ggml-base-q8_0.bin` (82 MB, con SHA-256 verificato).
2. `node orbit/tools/prova-stt.js --json` una volta così com'è e una volta con `ORBIT_STT_MODELLO=base` nell'ambiente, sulle stesse frasi, possibilmente anche su registrazioni vere della voce dell'utente.
3. Confrontare latenza, RTF e testi.

Prima di cambiare modello si possono provare due regolazioni che lasciano Small: `ORBIT_STT_THREADS=8`, oppure una finestra più stretta con `ORBIT_STT_CONTESTO=2` (circa 15% più veloce, un po' meno preciso).

**Modifica minima, solo con il consenso dell'utente:** aggiungere `ORBIT_STT_MODELLO=base` in `%LOCALAPPDATA%\Orbit\.env` e riavviare Orbit. Non serve toccare il codice: `orbit/voice/whisper.js` ha già nome, file e impronta di Base (`MODELLI.base`).
