<div align="center">

# 🪐 Orbit

**Il tuo assistente personale, sul tuo PC.**

Chat e voce · memoria sul tuo vault Obsidian · orchestrazione AI su Claude Code

![Windows 11](https://img.shields.io/badge/Windows-11-0078D4?logo=windows&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-339933?logo=node.js&logoColor=white)
![Dipendenze](https://img.shields.io/badge/dipendenze%20npm-0-brightgreen)
![Chiavi API](https://img.shields.io/badge/chiavi%20API-nessuna-blue)

[Funzioni](#cosa-c%C3%A8-cosa-%C3%A8-verificato-cosa-%C3%A8-pianificato) · [Requisiti](#requisiti) · [Avvio](#installazione-e-avvio) · [Configurazione](#configurazione) · [Test](#test-e-benchmark) · [Avvertenze](#avvertenze)

</div>

## In breve

- 🧠 **Orchestratore AI:** sceglie il modello Claude più economico adatto alla richiesta (Haiku, Sonnet, Opus), controlla la risposta prima di mostrarla e passa a un modello più capace solo quando serve.
- 📓 **Memoria Obsidian:** legge il tuo vault in sola lettura, con provenienza delle fonti.
- 🗣️ **Voce:** sintesi espressiva con ElevenLabs (riserva locale Piper), dettatura con Whisper e parola «Orbit» con Vosk.
- 🔑 **Nessuna chiave API:** usa `claude -p` con il login del tuo abbonamento, quindi niente fatturazione a consumo. Niente `npm install`.
- ⚡ **Veloce:** Claude gira in modalità persistente (processi pronti, web escluso); rollback con `ORBIT_CLAUDE_MODALITA=tradizionale`, vedi [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

> **Stato:** progetto personale in sviluppo, provato soltanto su Windows 11. Non è stata scelta nessuna licenza: finché non ne viene aggiunta una, tutti i diritti restano all'autore.

## Cosa c'è, cosa è verificato, cosa è pianificato

| Area | Implementato | Verificato | Note |
| :-- | :-- | :-- | :-- |
| Chat con router, Quality Gate ed escalation (Haiku, Sonnet, Opus) | sì | test automatici con provider finto; prove reali con i tre modelli sul PC dell'autore | l'escalation e la verifica AI sono provate soprattutto con mock |
| Memoria Obsidian in sola lettura (ricerca per sezioni, cache, provenienza) | sì | test automatici e benchmark su vault di esempio | l'indice è ricostruibile e sta fuori dal vault |
| Scrittura note controllata (crea, amplia, riscrivi, elimina) | sì | test automatici | ogni scrittura passa da permessi, conferma e backup |
| Documenti locali (cartelle autorizzate, sola lettura) | sì | test automatici | PDF e OCR richiedono strumenti esterni opzionali |
| Ricerca web | sì | test automatici; prova reale dell'autore | usa gli strumenti web di Claude Code |
| Google Calendar e Gmail (sola lettura) | sì | test automatici con API simulate | richiede un proprio client OAuth (vedi sotto) |
| Voce: ElevenLabs (sintesi espressiva, predefinita) con ripiego automatico su Piper locale; Whisper Small e Vosk (dettatura e parola «Orbit») | sì | test automatici con motori finti; audio generato verificato | ElevenLabs è l'unico servizio a pagamento e richiede una chiave propria; senza chiave si usa Piper; il microfono vero richiede una prova a mano |
| Risposte rapide locali (calcoli con due operandi espliciti) | sì | test automatici | verificate senza chiamate AI; i casi non certificati seguono la pipeline normale |
| Interfaccia (nucleo 3D animato, cronologia, Diagnostica AI con consumi e controlli di qualità) | sì | test automatici sugli stati, sul movimento e sulla diagnostica | non provata su iPad |
| Ricerca semantica e RAG | no | | si aggiunge registrando un motore in `memoria/ricerca.js` |
| Alexa, Apple Calendar, invio di e-mail, trading, telefonia, domotica | no | | esistono solo il contratto dei connettori e i permessi |

Tutte le integrazioni sono attivabili e disattivabili; se una non è configurata, Orbit e le altre continuano a funzionare. Orbit non invia messaggi, non elimina mail e non muove denaro.

## Requisiti

- **Windows 11** (la cifratura dei token usa DPAPI e gli installatori scaricano binari per Windows).
- **Node.js 22.5 o superiore** (`node -v`).
- **Claude Code** installato e collegato a un abbonamento claude.ai (`claude auth status` deve riportare `claude.ai`). Con chiave API o provider cloud Orbit non parte con la chat.
- Un **vault Obsidian** da collegare (anche vuoto, ma deve contenere la cartella `.obsidian`).
- Facoltativi: **Chrome** (dettatura e voce italiana), **Python 3.8+** (parola «Orbit» con Vosk), circa 400 MB di spazio per i modelli vocali. Whisper Small gira su CPU, senza scheda grafica.

## Installazione e avvio

```bash
git clone <indirizzo-del-repository> orbit-hud
cd orbit-hud
npm run verifica      # controlli statici e test automatici
node orbit/server.js  # oppure doppio clic su avvia-orbit.bat
```

Si apre `http://localhost:4778`. Il server ascolta solo su `127.0.0.1`. Da Impostazioni (ingranaggio) si vede se abbonamento, modelli e memoria sono a posto.

## Configurazione

Nessun file è obbligatorio. Per cambiare le impostazioni copia `orbit/.env.example` in `%LOCALAPPDATA%\Orbit\.env` (fuori dal vault) e togli il commento alle righe che servono. Le variabili d'ambiente di Windows hanno la precedenza sul file. Non mettere mai chiavi API nel file: Orbit le ignora.

| Variabile | A cosa serve |
| :-- | :-- |
| `ORBIT_VAULT_PATH` | Vault Obsidian da leggere |
| `ORBIT_UTENTE`, `ORBIT_UTENTE_PROFILO` | Nome e descrizione breve usati nei prompt e nei saluti (predefinito: «Utente», nessuna descrizione) |
| `ORBIT_PAROLE_CORSO` | Sigle dei propri corsi, separate da virgola, che fanno cercare nel vault |
| `ORBIT_MODEL_HAIKU`, `ORBIT_MODEL_SONNET`, `ORBIT_MODEL_OPUS` | Nomi dei modelli, se non si vogliono gli alias di Claude Code |
| `ORBIT_MAX_CALLS_PER_HOUR`, `ORBIT_MAX_CALLS_PER_DAY`, budget di token | Tetti di consumo |
| `ORBIT_PORT`, `ORBIT_DATA_DIR`, `ORBIT_INDEX_DIR` | Porta e cartelle dei dati |
| `ELEVENLABS_API_KEY`, `ORBIT_TTS_*` | Voce ElevenLabs: chiave, voce, modello e tetto mensile (vedi [docs/ELEVENLABS.md](docs/ELEVENLABS.md)); `ORBIT_TTS_MOTORE=piper` per la sola voce locale |
| `ORBIT_STT_*` | Riconoscimento vocale (vedi [docs/WHISPER-STT.md](docs/WHISPER-STT.md)) |

Il profilo personale si può tenere anche in `privato/orbit.env` (cartella esclusa da Git); `ORBIT_LOCAL_ENV` indica un altro file. Precedenza: ambiente, poi `.env` dei dati, poi file locale.

## Collegare il proprio vault

Se `.orbit-hud` sta dentro il vault, Orbit lo trova da solo (è la cartella che lo contiene). Altrimenti imposta `ORBIT_VAULT_PATH`, oppure crea una cartella `Orbit` in Documenti (anche reindirizzata su OneDrive). All'avvio Orbit controlla che il percorso esista, sia leggibile e contenga `.obsidian`; se no la chat funziona lo stesso e mostra l'errore. La memoria legge i file originali in sola lettura: l'indice (`indice.sqlite`) sta in `%LOCALAPPDATA%\Orbit` e si ricostruisce da solo. Vedi [memoria/LEGGIMI.md](memoria/LEGGIMI.md).

Un esempio completo di vault inventato è in `esempi/benchmark/vault/`; la skill `piano-oggi` di esempio, con le istruzioni per configurarla, è in `esempi/skills/piano-oggi/`.

## Modelli vocali

La sintesi predefinita è ElevenLabs (chiave e voce proprie, vedi [docs/ELEVENLABS.md](docs/ELEVENLABS.md)); se manca la chiave, i crediti finiscono o la rete non risponde, Orbit passa da solo a Piper. I modelli locali non stanno nel repository: si scaricano una volta, con verifica SHA-256, in `%LOCALAPPDATA%\Orbit` (fuori dal vault).

```bash
node orbit/tools/installa-voce.js   # voce italiana Piper, circa 86 MB
node orbit/tools/installa-stt.js    # Whisper Small e Vosk, circa 320 MB (serve Python)
```

Riavvia Orbit dopo l'installazione. Dettagli, diagnostica e come passare a Whisper Base: [docs/WHISPER-STT.md](docs/WHISPER-STT.md).

## Google Calendar e Gmail

Servono un proprio progetto Google Cloud e un client OAuth: nessuna credenziale è inclusa.

1. In Google Cloud crea un progetto e abilita **Google Calendar API** e **Gmail API**.
2. Configura la schermata di consenso (utente di test: il tuo account) e crea un **ID client OAuth di tipo «Applicazione desktop»**.
3. Scarica il JSON e salvalo come `%LOCALAPPDATA%\Orbit\google\client.json`.
4. In Orbit, Impostazioni e integrazioni, premi **Collega Google** e accedi nella pagina di Google.

Orbit chiede soltanto gli ambiti `calendar.readonly` e `gmail.readonly` e rifiuta un token con ambiti diversi. Il token è cifrato con DPAPI e non esce da `%LOCALAPPDATA%\Orbit\google`.

## Test e benchmark

```bash
npm run verifica   # controlli statici e test automatici (nessuna chiamata AI, nessuna credenziale)
```

I test usano provider finti, motori vocali finti e cartelle temporanee con dati inventati. Il benchmark della memoria ha due dataset, sempre distinti in modo esplicito:

```bash
node orbit/tools/bench-memoria.js --dataset pubblico         # vault inventato in esempi/benchmark, gira ovunque
node orbit/tools/validazione-memoria.js --dataset pubblico --locale
node orbit/tools/bench-memoria.js --dataset privato          # solo per chi ha un dataset in privato/benchmark e un vault proprio
```

Il dataset **privato** (`privato/benchmark/dataset.json`) non è nel repository; se manca, gli strumenti si fermano con un errore e non ripiegano mai sul pubblico. Il benchmark lavora sempre su una copia temporanea del vault.

## Cosa non è nel repository

Il vault, la cartella `privato/` (documenti di lavoro, benchmark originali, profilo locale), i file `.env`, i database e le conversazioni, le credenziali e i token Google, i modelli vocali e ogni binario pesante. Sono tutti esclusi da `.gitignore` e vivono sul PC dell'utente.

## Collaborare con Git

Strategia di branch, worktree separati per più agenti, checkpoint e rollback non distruttivi: [docs/GIT-COLLABORAZIONE.md](docs/GIT-COLLABORAZIONE.md).

## Avvertenze

- **Consumo e policy.** Orbit lancia più chiamate `claude -p` per domanda solo quando serve (verifica, escalation) e ha tetti orari e giornalieri. L'uso automatizzato di un abbonamento è una zona grigia delle condizioni di Anthropic: il rischio è di chi lo usa. Controlla che sull'account non sia attivo *Extra usage* e che nell'ambiente non ci siano `ANTHROPIC_API_KEY` o simili (Orbit le ignora e le toglie al processo figlio).
- **Dati personali.** Con ElevenLabs il testo di ogni frase letta ad alta voce viene inviato al servizio; con Piper resta sul PC. Le risposte possono citare il contenuto del vault; i documenti e le note recuperati sono trattati come dati non attendibili, non come istruzioni.
- **Limiti noti.** Router e verifica sono regole in italiano tarate a mano; non c'è streaming dei token (la risposta compare dopo il Quality Gate); l'accesso da iPad non esiste ancora.
