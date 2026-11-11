# Smart Inbox TS-5: integrazione con Orbit

Stato: integrazione sintetica, **inerte in produzione**. Non legge e non scrive il vault reale.

## Flusso

Richiesta ("Organizza to sort") → `rileva()` in `orchestrator.js` → integrazione `smartinbox` nel registro → permessi e conferme Orbit
→ `smart-inbox/cli.js` (stesso motore di TS-4: reader, planner, Safe Writer) → piano verificabile → (conferma) → Safe Writer.

- Strumenti: `prepara`, `valuta_piano`, `stato` (lettura), `applica`, `recupera` (modifica).
- Il modello vede solo `valuta_piano` e `stato`, nel solo turno di "Organizza to sort". `applica` e `recupera` partono solo da una
  richiesta esplicita dell'utente ("Applica piano Smart Inbox si_<id>") e non sono nel catalogo dinamico.
- Root, bundle, `archivia`, `recupero` e conferme non sono parametri accettabili dal modello: lo schema respinge i campi sconosciuti.
  Lo scope (`settings.smartInbox`) e solo dell'host; oggi nessun codice lo popola, quindi in produzione l'integrazione risulta
  "non configurata" ed e disabilitata di default.
- I piani vivono in memoria per 10 minuti, legati alla conversazione, uno alla volta per piano.
- `conversazione` arriva solo agli strumenti che la dichiarano (`conversazione: true`); gli altri ricevono ancora solo
  `{ richiesta, signal }` (invariante B0006 preservata).

## Valutazione automatica del piano

Dopo `prepara` l'orchestratore (`_valutaSmartInbox`) esegue da solo il passo semantico: legge le richieste con lo strumento interno `materiale`
(non nel catalogo del modello), fa UNA chiamata al modello del turno che restituisce solo la relazione per indice (equivalente/distinta/incerta),
rimette percorsi e hash dal codice e chiama `valuta_piano`. Errori o risposte non valide lasciano il piano com'e: il modello puo ancora chiamare
`valuta_piano`. L'applicazione resta una richiesta esplicita dell'utente con la conferma locale del writer.

## create_dir (cartelle di creazione mancanti)

Se una cartella di `creaIn` non esiste ma il suo genitore si, il piano la include in `cartelleDaCreare` e `spec.mkdirs` (stessa preview, stesso hash,
stessa finestra locale: nessuna seconda conferma). Solo un livello, solo cartelle di `creaIn` usate da una nuova nota del piano. Il motore nativo
(`Engine.cs`, `Root.MakeDirectory`) la crea relativa alla directory genitore gia fissata (no-follow, niente reparse), con journal `mkdir-intent`/`mkdir-done`,
ricontrolla i nomi della directory genitore e non tocca note esistenti. Una cartella gia presente prima dell'apply e un errore; dopo un intent interrotto
e accettata solo se vuota. Rollback e fallimenti lasciano la cartella vuota (nessuna eliminazione). Con `autoApplica` la creazione di cartelle richiede
comunque la finestra. **Richiede un nuovo pin del manifest** (`node smart-inbox/integrita.js --pin`): `Engine.cs` e `cli-host.ps1` sono cambiati.

## Autorizzazioni (invariate)

Restano entrambi i controlli: permesso Orbit per le modifiche (`applica`/`recupera` = livello `modifica`, conferma per parametri)
e conferma locale esatta del bridge Windows TS-4 a ogni apply. Una conferma generata dal modello non ha valore.

## Per un'autorizzazione limitata futura (NON implementata)

Per "automatico per i casi chiari, conferma per gli ambigui" servirebbero, con nuova autorizzazione dell'utente:

1. Una regola nel `PermissionManager` per `smartinbox.applica` con scope fisso (cartella `to sort` e destinazioni autorizzate),
   limitata a piani con tutte le decisioni MERGE/CREATE/NOOP e nessun CONFIRM/BLOCK, e legata all'impronta del piano.
2. Una modalita del bridge TS-4 che accetti una pre-autorizzazione locale firmata (piano + hash esatti) al posto della finestra,
   oggi richiesta a ogni apply.
3. La popolazione di `settings.smartInbox` da configurazione dell'host, con verifica del vault reale (oggi solo staging sintetico).
4. Il collaudo con dialogo umano reale e vault di prova prima di qualsiasi uso sul vault personale.

## Verifiche

`orbit/tests/smart-inbox.test.js` richiede un runner con filesystem sintetico: `node --permission --allow-fs-write=<stage>`,
`ORBIT_TS5_TEST_STAGE` e i percorsi `ORBIT_*` sotto lo stage `orbit-smart-inbox-ts3-<32 hex>`. Usa provider mock e un backend
nativo finto che non concede mai consensi: non sostituisce il collaudo reale del bridge Windows.

## Note di sicurezza statica

- `child_process` entra nel runtime solo tramite `smart-inbox/cli-windows.js` (pwsh del bridge TS-4, runtime verificato con SHA-256 e ambiente ridotto), fuori dalla cartella controllata da `orbit/tools/check.js`. E un'eccezione nota e raggiungibile solo con `settings.smartInbox` configurato dall'host (oggi mai).
- Con l'integrazione disabilitata "Organizza to sort" segue il percorso normale: la skill non si attiva.
- `applica` e `recupera` annullano lo strumento allo scadere del timeout (200 s); un apply gia in esecuzione nel bridge puo comunque completarsi, per questo il messaggio di timeout dice che l'esito puo essere sconosciuto e rimanda a "Stato piano Smart Inbox <id>".
