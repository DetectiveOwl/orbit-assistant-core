# Smart Inbox: attivazione sul vault reale (PREPARATA, NON APPLICATA)

Stato osservato in sola lettura il 22/10/2026. Nulla di quanto segue e stato applicato: serve l'approvazione separata dell'utente.

## Comportamento a regime
«Organizza to sort» fa tutto in una richiesta: prepara, fa valutare i candidati dal modello del turno, il codice verifica il piano, sceglie il sottoinsieme di operazioni
**indipendenti dalle decisioni in sospeso** e consentite dal profilo, le applica con Safe Writer e bridge, ispeziona il risultato e riporta solo cio che e stato scritto.
Restano in sospeso (con il motivo): CONFIRM, BLOCK, le note **legate** a una nota in sospeso (due note potenzialmente equivalenti restano entrambe ferme: nessuna delle due e indipendente
dall'altra), le operazioni fuori dal profilo. `append` e `create_dir` non sono nel profilo consigliato e chiedono conferma.

## Configurazione attuale dell'host (solo lettura)
`<CARTELLA-CONFIG-SMART-INBOX>\ambito.nuovo.json`: `autorizzati` = cervello, corsi, inbox, Notion, progetti, smart inbox; `creaIn` = smart inbox; `creaDefault` = smart inbox; `autoApplica: true`.
**Attenzione:** senza `autoOperazioni`/`autoCartelle` il default e `create` + `append` in TUTTE le cartelle autorizzate. Con la nuova versione il profilo va ristretto.

## Profilo proposto (da approvare): solo create
Aggiungere a `ambito.nuovo.json` (resto invariato):
```json
"autoApplica": true,
"autoOperazioni": ["create"],
"autoCartelle": ["smart inbox"]
```
Effetto: senza finestra si creano solo note nuove in `smart inbox`; append, create_dir e qualunque altra cartella restano da confermare. Revoca: `"autoApplica": false` (o togliere la chiave) e riavvio.

## Pin del lanciatore
`<CARTELLA-CONFIG-SMART-INBOX>\avvia-orbit-smartinbox.bat`, riga 8. Gli script del bridge non sono cambiati rispetto al pin gia verificato dell'integrazione; il manifest e (`node smart-inbox/integrita.js --pin`):
```diff
-set "SMART_INBOX_SCRIPT_MANIFEST_SHA256=8297caa2e4126b5e27a94552f5df95e639fd202d5ffc30fe5baea28ca709d0ea"
+set "SMART_INBOX_SCRIPT_MANIFEST_SHA256=bb09480899a01bfbc559dfce7311046e8b9d11c35d4c752b29e172aead8ba637"
```
(il vecchio pin descrive `cli-host.ps1` senza il fix UTF-8 e senza le regole `-AutoOps/-AutoFolders`.)

## Servizi da riavviare
Il lanciatore avvia Orbit dal checkout `.orbit-hud` e rifiuta di partire se ci sono modifiche tracciate non committate. Al momento nessun backend Orbit (`orbit/server.js`) risulta in esecuzione
(solo processi node di altri strumenti): basta avviare dal lanciatore dopo l'approvazione. Se Orbit fosse gia avviato va riavviato per caricare codice, profilo e pin.

## Prova sul percorso operativo con dati sintetici (senza scrittura sul vault personale)
`node smart-inbox/tests/e2e-accettazione.cjs` (PowerShell: `$env:SMART_INBOX_PWSH='<PERCORSO-POWERSHELL-7>\pwsh.exe'; $env:SMART_INBOX_SCRIPT_MANIFEST_SHA256=(node smart-inbox/integrita.js --pin)`).
Lo scenario «percorso operativo» carica il profilo da un file `ORBIT_SMART_INBOX_AMBITO` con `config.carica`, come il lanciatore, ma con stage e vault temporanei; il vault personale non e mai aperto.

## Passi (dopo approvazione)
1. Aggiornare il pin nel lanciatore. 2. Aggiungere le due chiavi al profilo. 3. Avviare Orbit dal lanciatore. 4. Prima richiesta reale con poche note sicure e verifica manuale dei file creati.
