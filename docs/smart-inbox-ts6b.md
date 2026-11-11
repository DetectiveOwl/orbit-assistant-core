# Smart Inbox TS-6B: ultime verifiche tecniche

Stato: branch `claude/smart-inbox-ts6b` da `3e74cf0` (TS-6A). Solo ambiente sintetico; il vault personale non e usato, non esiste la cartella reale `to sort`, Smart Inbox non e attivata.

## 1. Integrita degli script del bridge

**Cosa protegge.** `windows/cli-host.ps1`, `Handles.cs`, `Engine.cs` sono elencati in `smart-inbox/windows/MANIFEST.sha256` (formato `sha256sum`, hash sul contenuto con fine riga LF, cosi autocrlf non cambia il risultato). Prima di ogni avvio `cli-windows.js` chiama `verificaScript()` (`smart-inbox/integrita.js`):
- il manifest deve elencare i tre file richiesti e ogni riga deve avere hash e nome validi; la cartella `windows/` deve contenere **esattamente** quei file (niente file in piu, mancanti, cartelle o collegamenti);
- ogni file deve avere l'hash del manifest;
- i **byte verificati** (non il repository) vengono scritti in una cartella nuova `<stage>/tmp/bridge-<casuale>` e `pwsh` parte da li; la cartella viene rimossa alla chiusura. la finestra tra verifica e uso si riduce a quella tra la scrittura della copia e la lettura da parte di `pwsh` (e, per gli .cs, al ricontrollo dell'hash prima di `Add-Type`), ma non e azzerata: un processo con gli stessi privilegi potrebbe sostituire la copia in quell'intervallo;
- `cli-host.ps1` ricalcola l'hash di `Handles.cs` ed `Engine.cs` (nomi fissi, hash passati da Node) prima di `Add-Type` e rifiuta l'avvio se differiscono.
Il modello non sceglie nulla: i nomi vengono dal manifest e dal codice, non dalla richiesta. Le verifiche gia esistenti (SHA-256 di `pwsh.exe`, `shell:false`, ambiente sintetico, nessun segreto ereditato) non cambiano.

**Origine di fiducia (da leggere con attenzione).**
1. Il codice Node dell'host (`cli-windows.js`, `integrita.js`) e il manifest vivono nello stesso repository degli script. La verifica quindi garantisce che cio che gira sia **cio che il manifest dichiara**, e rende visibile in `git diff` ogni modifica agli script (devono cambiare insieme al manifest). Protegge da modifiche parziali o dimenticate, file sostituiti o aggiunti, corruzione, e da script scelti dal modello.
2. Aggiornare uno script non rompe nulla in modo nascosto: `node smart-inbox/integrita.js --scrivi` rigenera il manifest; il test `smart-inbox-integrita.test.js` fallisce se manifest e file divergono. Nessun hash e scritto nel codice.
3. **Pin facoltativo dell'host** (`SMART_INBOX_SCRIPT_MANIFEST_SHA256`, hash del manifest): sposta l'origine di fiducia **fuori dal repository**, su una versione che l'utente ha rivisto. Se impostato, un manifest ricalcolato da chi ha modificato gli script viene rifiutato (`MANIFEST_BRIDGE_PIN_DIVERSO`). Va aggiornato dall'utente quando decide di accettare una nuova versione; spento di default.
4. **Non protegge** da chi ha gli stessi privilegi dell'utente e puo riscrivere insieme script, manifest, codice Node e (se non c'e il pin) anche la configurazione. Non e una sandbox del sistema operativo ne una firma digitale del codice.

## 2. RECOVER end-to-end

Vedi sezione "Risultati" sotto (harness `smart-inbox/tests/e2e-ts6b.cjs`, bridge reale, Safe Writer reale, crash reale del processo del bridge, vault sintetico, **consenso simulato**).

## 3. Perimetro di configurazione

`smart-inbox/perimetro.js`. La configurazione resta solo quella dell'host (`ORBIT_SMART_INBOX_AMBITO`, spenta di default). Livelli, tutti obbligatori:
1. **Forma e percorsi** (`validaAmbito`, senza disco): chiavi complete e senza extra; `stage` assoluto, normalizzato (nessun `..`, `/`, UNC), con nome `orbit-smart-inbox-ts3-<32 hex>`; `vault` e `technical` relativi, normalizzati, non nelle cartelle del bridge (`home`, `tmp`), **separati e non annidati**; cartelle `autorizzati` non vuote e non tecniche/protette/`to sort`; `creaIn` solo dentro le autorizzate. Lo stage non puo contenere ne stare dentro un'**area operativa di Orbit**: il repository, e quelle passate dall'host (`app.js` passa il vault personale e la cartella dati, letti dalla configurazione dell'host: nessun percorso e scritto nel codice).
2. **Percorsi effettivi** (`verificaPerimetroFs`, prima di ogni avvio del bridge e nei prerequisiti): lo stage esiste, il suo percorso reale coincide con quello dichiarato (nessun junction/collegamento), stessa verifica per vault e area tecnica, nessuna sovrapposizione con le aree operative (anche sul percorso reale), e **marker** `.orbit-smart-inbox-perimetro.json` nello stage con `{versione:1, tipo:'sintetico', stage:<stesso percorso>}`.
3. **Bridge**: `cli-host.ps1` rifiuta uno stage senza marker coerente (oltre alle verifiche gia presenti su nome, disco fisso, reparse point, ambiente).
Il confine sintetico non dipende piu solo dal nome dello stage. **Solo `tipo: sintetico` e abilitato**: `TIPI_ABILITATI` e nel codice, quindi un ambiente non sintetico non si abilita da configurazione ne da marker (`AMBIENTE_NON_SINTETICO_NON_ABILITATO`).

Per dichiarare uno stage sintetico l'host scrive il marker (mai sovrascrive): `node -e "require('./smart-inbox/perimetro').scriviMarker(process.argv[1])" <stage>`.

**Per il vault personale in futuro** servira una decisione esplicita e separata: aggiungere il tipo in `TIPI_ABILITATI`, generalizzare il controllo del nome in `Handles.cs` (`InitializeSyntheticBoundary`) e `cli-host.ps1` (oggi richiedono ancora il nome sintetico: e un secondo strato volutamente restrittivo), e gestire home/tmp/technical del bridge fuori dal vault. Nulla di questo e abilitato.

## 4. Altri problemi

- **NOOP chiedeva consenso e risultava APPLIED** (corretto, `smart-inbox/cli.js`): un piano di soli NOOP senza archiviazione non puo scrivere; ora il writer esegue solo `inspect` (verifica catalogo e sorgenti), non c'e finestra di consenso e l'esito e `NOOP`, non `APPLIED`. MERGE/CREATE e qualunque piano con archiviazione continuano a richiedere il consenso locale. La policy generale delle conferme di Orbit (`applica` e un'azione di livello `modifica`) non e cambiata.
- **Recupero con ambito non valido** (corretto): la capability viene validata prima di chiedere il consenso, quindi un recupero per un output sconosciuto non apre piu la finestra.
- **P3 di SECONDARIO su TS-6A**: (1) il test che creava una cartella in `smart-inbox/` ora usa `raccogliFile()` su una cartella temporanea (corretto); (2) l'harness `e2e-ts6a.cjs` ora esce con 1 se un controllo atteso fallisce, e `e2e-ts6b.cjs` esce con 1 per ogni controllo fallito (corretto); (3) l'affermazione "possono solo crescere" non era verificata: in `e2e-ts6b.cjs` si verifica che i file della cartella tecnica (request, journal, backup) restino invariati dopo il recupero, mentre per `home`/`tmp` del bridge (file temporanei del compilatore) **non** si afferma nulla.
- **Comportamento dopo riavvio**: i piani Orbit sono in memoria (scadenza 10 minuti, nessuna persistenza): dopo un riavvio `Applica/Recupera piano si_...` risponde `PIANO_SMART_INBOX_NON_DISPONIBILE`. Il journal e i backup sul disco restano. **Il recupero di un'operazione interrotta richiede il bundle originale** (la CLI lo accetta in JSON; l'integrazione Orbit non lo conserva): senza il bundle l'utente deve fermarsi e non rieseguire alla cieca. Non corretto (richiederebbe persistere il bundle nell'area tecnica: nuova funzione): limite documentato, vedi sezione limiti.
- Non toccati: `planner.test.js` e `reader.test.js` (falliscono anche su baseline cercando `Orbit-Worktrees\control\spec.json`), anomalia `voice/voce-locale.js` in `check.js`, la policy generale delle conferme.

## Risultati

Runtime: PowerShell 7.6.7 win-x64 portabile; lo zip ha lo stesso hash di `hashes.sha256` della release ufficiale (d2f952eb...), `pwsh.exe` coincide con il pin fa2c8bb1... e ha firma valida. Estratto in una cartella temporanea e rimosso a fine prova.

**Consenso SIMULATO**: l'harness usa una copia temporanea di `cli-host.ps1` con `$answer=$true` al posto della finestra e un punto di crash nei checkpoint del motore. Il consenso umano e la finestra NON sono stati testati.

`node smart-inbox/tests/e2e-ts6b.cjs`: **39/39 controlli, in 3 esecuzioni consecutive, sempre con esito 0**. `e2e-ts6a.cjs` (Dune/Alien) rieseguito: `attesiOk`.

- **RECOVER (scenario A)**: apply interrotto da un crash reale del processo del bridge (Environment.Exit al primo blocco scritto), destinazione parziale. Lo status segnala RECOVERY_REQUIRED. Rifiutati: apply sul parziale; recover con hash o fileId non osservati; recover senza concessione; recover per un output sconosciuto (rifiutato prima del consenso); consenso negato; execute senza consenso del bridge; azione rollback. Il recover autorizzato porta a APPLIED: destinazione con l'hash previsto, Alien e ogni titolo una sola volta, sorgente intatta. Il journal ha la catena di hash verificata in modo indipendente (write-intent due volte, un solo done). I backup sono coerenti (originale destinazione e sorgente, stato prima del tentativo = originale e parziale). Il replay di apply/recover non scrive e non duplica. Una nota dell'utente aggiunta dopo il recupero non viene sovrascritta. I file della cartella tecnica restano invariati dopo il recupero e fuori dal perimetro nulla cambia.
- **Scenario B**: nota dell'utente aggiunta tra crash e recupero: il recover e rifiutato, parziale e nota restano intatti (la riparazione e manuale, dai backup).
- **Scenario Z (strumenti Orbit)**: prerequisiti con perimetro reale, MERGE e apply, recupera senza parziale rifiutato, secondo ciclo NOOP senza consenso.
- **Scenario P**: script alterati (Engine.cs, cli-host.ps1, file in piu) rifiutati prima di qualsiasi avvio; pin del manifest; stage dentro un'area operativa; senza marker o con tipo non sintetico; il bridge rifiuta da solo hash .cs diversi o mancanti e uno stage senza marker.
- **Non eseguiti**: suite TS3/TS4 Windows (`run-ts3-windows.ps1`, `run-ts4-windows.ps1`), runtime sbagliato (`SMART_INBOX_PWSH_SBAGLIATO`), dialogo umano, uso del vault personale.
- **Unit test**: integrita 8, perimetro 14, noop 3, check statico 5, config 4 = 34/34. TS5 (`smart-inbox.test.js` sotto `node --permission`, stage sintetico) 19/19.

## Limiti residui

- Il bundle del piano non e persistito: dopo il riavvio di Orbit un'operazione interrotta si recupera solo con la CLI e il bundle originale.
- Dopo una modifica dell'utente su un parziale il recupero e rifiutato (nessuna perdita, riparazione manuale dai backup).
- Manifest e codice host stanno nello stesso repository: senza il pin facoltativo non c'e protezione da chi riscrive tutto con gli stessi privilegi.
- Bridge e Handles.cs richiedono ancora il nome stage sintetico: usare il vault personale richiede un intervento separato e deliberato.

## Prerequisiti e note di ambiente (revisione SECONDARIO)

- **Prima di usare il vault personale** il pin del manifest (`SMART_INBOX_SCRIPT_MANIFEST_SHA256`) fuori dal repository deve diventare obbligatorio. Oggi e facoltativo; non e stato implementato qui.
- **Test del perimetro sotto `node --permission`**: alcuni test di `smart-inbox-perimetro.test.js` creano junction e stage in `os.tmpdir()`. Con un TEMP molto lungo (limite del nome stage di 200 caratteri) o con il runner `--permission`, che non ammette junction, possono fallire: sono limiti dell'ambiente di prova, non del codice. Eseguirli con `npm test`/`node --test` e un TEMP corto.

## Pin obbligatorio del manifest (branch `claude/smart-inbox-pin`)

Dal punto 1 il pin dell'host non e piu facoltativo:
- `cli-windows.js` chiama `verificaScript({ pin, obbligatorio: true })`: **senza pin, con pin non valido (non 64 esadecimali) o diverso dall'hash del manifest il bridge non parte**, quindi nessuna scrittura (`MANIFEST_BRIDGE_PIN_MANCANTE`, `..._NON_VALIDO`, `..._DIVERSO`). Il controllo precede lo spawn e non sostituisce quelli esistenti (runtime, perimetro, integrita degli script).
- Il pin e `SMART_INBOX_SCRIPT_MANIFEST_SHA256`, impostato dall'host **fuori dal repository**: nessun valore e scritto nel codice. Per ottenerlo dopo aver rivisto gli script: `node smart-inbox/integrita.js --pin`. Quando gli script cambiano, `--scrivi` rigenera il manifest e il pin va rivisto e aggiornato dall'utente: e il passaggio che impedisce di accettare in silenzio uno script nuovo.
- I `prerequisiti` dell'integrazione Orbit segnalano "non configurata" con il motivo se il pin manca o non corrisponde, prima ancora di tentare un'operazione.
- Smart Inbox resta disabilitata di default (nessuno scope = nessuna integrazione).
- Il lanciatore del collaudo sintetico deve ora impostare anche questa variabile.
- Test: unitari (pin mancante/non valido/diverso, manifest ricalcolato dopo manomissione), prerequisiti, regola statica (`obbligatorio: true` in `cli-windows.js`), TS5 19/19. Gli harness E2E sono stati adeguati (pin della copia di test) **ma non rieseguiti** in questo branch: richiedono pwsh 7.6.7 portabile.

## Perimetro "reale" (branch `claude/smart-inbox-vault-reale`)

Secondo tipo abilitato nel codice (`TIPI_ABILITATI = ['sintetico', 'reale']`). Non si abilita da configurazione.
- **Stage** `orbit-smart-inbox-real-<32 hex>` FUORI dal vault: contiene solo `technical/`, `home/`, `tmp/` e il marker `{versione:1, tipo:'reale', stage, vault}` scritto dall'host (`scriviMarker(stage, vault)`).
- **Vault** = percorso assoluto normalizzato nel contesto; deve coincidere col vault del marker (Node e bridge), stesso disco dello stage, mai dentro o sopra lo stage. Tipo del marker e nome dello stage devono corrispondere.
- **Bridge**: `Handles.cs` ammette come radici solo lo stage e quel vault (`InitializeBoundary`); `cli-host.ps1` rifiuta un vault del pacchetto diverso da quello del marker (`CONTEXT_CHANGED`). Il consenso mostra "Vault REALE". Restano invariati: reparse point/junction, NTFS, scritture solo in `autorizzati`, `to sort` mai scritta, aree protette (`policy.protetto`: `cervello`, `scadenze`, cartelle che iniziano per `.`, `progetti/Orbit`, ...), pin del manifest obbligatorio.
- Il testo delle istruzioni al modello (`ISTRUZIONI`) e il nome dell'integrazione dicono ancora "sintetico": solo etichette, non toccate.
- Verificato: 39 test unitari/statici (incluso TS5 e 2 nuovi test "reale"); `e2e-ts6b` con pwsh 7.6.7 reale: 38 OK e 1 FAIL (`Z: prerequisiti`), identico sul commit di base 128d090 (problema preesistente dell'harness); prepare read-only su vault temporaneo di tipo reale col bridge vero. Il consenso umano e la finestra NON sono stati provati.
