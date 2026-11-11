# Smart Inbox — TS-1 e TS-2

Libreria indipendente per leggere note da una inbox e proporre un piano verificabile. Non contiene writer, archiviazione, applicazione o rollback eseguibile, CLI operativa, skill o collegamenti a Orbit/Claude. Nessuna configurazione, scansione o apertura di database avviene all'importazione.

## File e dipendenze

- `smart-inbox/policy.js`: percorsi, aree protette, impronte e serializzazione canonica.
- `smart-inbox/reader.js`: lettura esplicita, metadati e snapshot immutabile.
- `smart-inbox/planner.js`: candidati, decisioni, aggiunte originali e verifica del piano.
- `smart-inbox/tests/`: fixture sintetiche, test, canarini e runner Windows dedicato.

Il solo componente applicativo condiviso è `memoria/analisi.js`, riutilizzato senza modificarlo. Nessuna dipendenza aggiunta. Non vengono importati configurazione Orbit, memoria/config, gateway, profilo, SQLite o provider.

## TS-1: contratto di lettura

`leggiSnapshot({ radice, autorizzati, creaIn, limiti, verificaReparse })` richiede una root locale assoluta esplicita e un elenco non vuoto di percorsi relativi autorizzati del catalogo. La inbox è la directory relativa `to sort`, che deve già esistere. Non viene creata. `creaIn` indica esclusivamente directory autorizzate già esistenti.

Su Windows `verificaReparse(percorsoAssoluto)` deve essere una funzione fidata che restituisce un booleano ottenuto dagli attributi nativi. Se manca o non dà una risposta certa, la lettura si arresta. Il chiamante deve garantire un controllo aggiornato o uno snapshot realmente immutabile; una callback che restituisce sempre `false` non soddisfa il contratto. Non viene fornito un adapter operativo che interroghi il vault personale.

Lo snapshot espone:

- `sorgenti`, `catalogo`: percorso relativo, SHA-256 dei byte completi, testo UTF-8 originale, titolo, filename, alias, frontmatter, sezioni, link e unità originali.
- `cartelle`: percorsi e identità filesystem delle directory esaminate.
- `copertura`: ambito autorizzato, completezza, problemi, byte, elementi visitati e limiti.
- `rootId`, `schema`, `impronta`: identità della root e impronta dell'intero snapshot.

Il titolo usa frontmatter `title`, poi H1, poi filename: anche note vuote hanno un nome confrontabile. I limiti predefiniti sono 1.000 note, 512 KiB per file, 8 MiB complessivi, 10.000 elementi e profondità 16. Limiti, errori, UTF-8 invalido, lettura parziale, modifiche osservate, collisioni NFC/case, directory mancanti e YAML non supportato rendono esplicita la copertura incompleta. Non vengono presentati prefissi come note complete.

Negli heading ATX un run finale di `#` è chiusura solo se separato dal contenuto da spazio/tab, oppure costituisce l'intero contenuto dell'heading. Gli hash attaccati al testo restano letterali: `# C#` ha titolo `C#`, mentre `# C# ###` rimuove solo la chiusura `###`. La stessa regola locale TS alimenta H1, sezioni e gerarchie delle unità. L'adapter corregge i titoli restituiti da `sezioniNota` rileggendo le righe originali e ricostruendo i percorsi gerarchici senza cambiare offset o testo; il parser condiviso non è modificato. Sintassi riconosciuta dal parser condiviso ma non dall'adapter rende incompleta la copertura. Non viene introdotto un interprete completo del markup inline.

Il parser frontmatter condiviso gestisce un sottoinsieme semplice: strutture complesse o ambigue non sono considerate evidenza completa. Le unità mantengono contenuto, posizione UTF-16 nel testo, sezione, separazione precedente e terminatore; i blocchi fenced restano atomici. Non viene generato nuovo contenuto.

Per i fence vengono conservati carattere e lunghezza dell'apertura. La chiusura deve usare lo stesso carattere almeno altrettante volte, con indentazione di massimo tre spazi e senza testo successivo. Delimitatori più corti o di tipo diverso restano contenuto. Un blocco non chiuso prosegue fino a EOF. Prima di ricavare metadati, il codice viene oscurato senza cambiare lunghezze o terminatori: H1 e link interni non diventano titolo o collegamenti della nota. Fence con sintassi non supportata rendono incompleta la copertura con `MARKDOWN_PARZIALMENTE_SUPPORTATO`; i motivi di parsing sono esposti in `problemiParsing`.

La policy rifiuta traversal, percorsi assoluti/UNC/device/ADS, nomi Windows riservati, componenti ambigui, link/junction/reparse e hardlink nei file letti. Esclude aree personali, operative e tecniche centralmente, incluse cervello, scadenze, progetti/Orbit, configurazioni, credenziali, codice e database. Non legge il resto della root fuori dall'ambito autorizzato. Esclusioni incontrate dentro l'ambito sono segnalate come lacune, non usate come prova di assenza.

## TS-2: contratto semantico e piano

`candidati(sorgente, catalogo)` ordina deterministicamente titolo, filename, alias, riferimenti e sovrapposizione lessicale. La sola normalizzazione semantica incorporata è `guardare` → `vedere`. Stato e negazione non vengono eliminati. Un punteggio alto non prova equivalenza.

`indizioIdentita` indica soltanto un collegamento utile a cercare o chiedere conferma. `identitaSupportata` richiede invece concordanza del titolo principale normalizzato: filename e alias non possono sostituire titoli discordanti, e un normale link non dimostra equivalenza. Il filename rimane titolo solo quando la nota non ne dichiara uno. Titoli concordi sono un requisito conservativo, non una garanzia semantica; per MERGE rimane necessaria la valutazione concorde. Più candidati plausibili continuano a richiedere conferma anche quando uno solo ha il titolo concorde.

`await pianifica(snapshot, opzioni)` accetta soltanto un valutatore iniettato. Non contiene adapter AI. Esempio schematico, per dati sintetici già letti:

```js
const piano = await pianifica(snapshot, {
  creaIn: { 'to sort/Ricette.md': 'liste' },
  valuta: ({ candidati }) => ({
    valutazioni: candidati.map(n => ({
      percorso: n.percorso,
      sha256: n.sha256,
      relazione: 'distinta'
    }))
  })
});
const controllo = verificaPiano(piano, snapshot);
```

L'esempio è un mock del contratto, non un classificatore utilizzabile per decidere l'assenza reale. Ogni valutazione deve indicare un candidato offerto e il suo hash, con relazione `equivalente`, `distinta` o `incerta`. `motivo` e `confidence` sono ammessi, ma la confidence non autorizza operazioni. Percorsi sconosciuti/protetti, hash incongruenti, duplicati e proposte di contenuto o azioni sono respinti.

Il valutatore riceve esclusivamente sorgente, candidati, metadati di copertura e `AbortSignal`. Default: massimo 8 candidati e 4 chiamate per piano, 24.000 caratteri di testo delle note per chiamata e 2.500 ms per valutazione. Il limite dei caratteri riguarda il testo, non i token né la dimensione totale della rappresentazione serializzata dei metadati. Una futura integrazione deve misurare anche il prompt effettivo e rispettare le autorizzazioni sui dati. Il timeout interrompe l'attesa e segnala abort; il valutatore deve cooperare alla cancellazione. Questo contratto non può terminare forzatamente una funzione iniettata che ignori il segnale.

| Esito | Condizioni principali |
| --- | --- |
| MERGE | Una sola identità supportata dal titolo principale, stato compatibile e valutazione semantica concorde, senza incertezze. Solo unità originali assenti nella destinazione. |
| CREATE | Assenza verificata in tutto l'ambito autorizzato e directory esplicita, esistente, autorizzata. Nome non occupato né da file né da directory. |
| CONFIRM | Ambiguità, conflitto, copertura/valutazione incompleta, assenza non provata, budget esaurito o timeout. Nessuna operazione per quell'input. |
| BLOCK | Riferimento protetto/non sicuro, proposta fuori contratto o destinazione non autorizzata. Nessuna operazione per quell'input. |
| NOOP | Identità concorde e contenuto originale già presente. Fra nuove note servono testo completo identico, titoli e stato compatibili e stessa directory di destinazione. Nessuna scrittura, archiviazione o cancellazione implicita. |

Un catalogo vuoto ma completamente letto prova assenza soltanto nel proprio ambito. Con catalogo non vuoto servono valutazioni esaustive concordi e nessuna identità plausibile. Un top-N non esaustivo non autorizza CREATE. Due destinazioni plausibili richiedono conferma prima di interrogare il mock. Le differenze fra “da vedere” e “già visti”, checkbox e negazioni rilevate non vengono cancellate dalla deduplicazione.

Il piano include ID e impronta, riferimenti sorgente/destinazione con hash, impronta dello snapshot, directory e copertura, motivi, budget consumato e operazioni descrittive. MERGE contiene soltanto aggiunte con contenuto e intervalli originali; CREATE contiene il testo originale completo. Più sorgenti verso la stessa destinazione condividono una deduplicazione interna al piano. Consenso utente e nuova verifica dei permessi restano necessari.

Prima di CREATE viene confrontato anche il contenuto delle note già proposte, indipendentemente dal filename finale. Copie complete con stessa identità nella stessa directory producono una sola creazione. Titoli/alias/riferimenti plausibili, unità comuni, stesso nome occupato da una proposta o testi identici con destinazioni diverse richiedono CONFIRM. Note con contenuto e indizi distinti restano creazioni separate. Non viene tentata una fusione semantica automatica fra sorgenti.

`verificaPiano(piano, snapshot)` controlla integrità, root, snapshot, percorsi, hash, contenuto originale, duplicazioni e conflitti delle operazioni. Riutilizza i vincoli di identità per MERGE/NOOP e il confronto tra nuove note per CREATE. Anche un piano con hash ricalcolato viene respinto se propone gli specifici MERGE/NOOP incoerenti o le creazioni duplicate coperti dai test. Spostare una nota, cambiarne testo o root invalida il vecchio piano. Nessuna funzione applica il piano.

## Limiti e condizioni prima di TS-3

- SHA-256 rileva alterazioni rispetto all'impronta fidata, ma non è firma né autenticazione contro chi può riscrivere piano, snapshot e hash. Il chiamante deve custodire le evidenze fidate.
- Le verifiche di path, attributi, inode e lettura riducono le race osservabili; pure API Node non costituiscono uno snapshot atomico contro modifiche ostili concorrenti. Prima di scrivere serviranno un confine filesystem appropriato e una nuova verifica di tutte le precondizioni.
- Le prove Windows usano attributi nativi rilevati dal supervisore su fixture rese in sola lettura ai test. Non dimostrano un adapter nativo live per un vault modificabile.
- La deduplicazione è conservativa e per unità/sezione. Equivalenza parafrastica, strutture Markdown complesse e conflitti semantici generali non sono risolti automaticamente.
- Non vengono misurate qualità semantica reale, latenza AI o risparmi operativi. Nessun dato personale o provider reale è stato usato.

## Validazione riproducibile autorizzata

Il runner `smart-inbox/tests/run-windows.ps1` è esclusivamente infrastruttura di test. Richiede Windows, PowerShell con le API .NET utilizzate, Node v24.16.0 con SHA previsto, branch/baseline e manifest B0006 fissati. Nessun pacchetto viene installato. Non è una CLI Smart Inbox di produzione.

Copia byte per byte nove file espliciti in uno staging nuovo in TEMP, verifica SHA-256 e grafo degli import, elimina credenziali dall'ambiente del figlio, usa HOME e configurazioni sintetici, assegna un Job Object prima dei canarini/import. La guardia blocca percorsi fuori staging, scritture a sorgenti/vault sintetici durante i test, moduli operativi, SQLite, processi figli e rete. È una barriera per questi test fidati, non una sandbox contro codice ostile.

Prima dei test esegue sintassi, preparazione fixture, canarini e import a freddo senza accessi dati. Richiede TAP conclusivo ed exit code 0. Ogni fase ha watchdog finito e cleanup tramite Job Object con conferma degli handle terminati. Confronta dopo le prove hash dei sorgenti e dei dati sintetici, main e manifest B0006. Log, piani JSON e risultati rimangono ignorati in `risultati/`; le directory temporanee vengono conservate per audit, senza pulizie automatiche.

Sono coperti 87 casi TS-1/TS-2, compresa la regressione del parser condiviso. Prima delle correzioni dell'audit, 14 nuovi controlli hanno riprodotto i tre difetti sul codice originale (52 PASS e 14 FAIL su 66, inclusi tutti i 51 test precedenti PASS). La successiva correzione degli hash letterali è preceduta da 11 FAIL su 87 casi, con tutti i 71 precedenti ancora PASS. Il runner non esegue la suite generale Orbit e non accede ai servizi operativi. Una futura adozione richiede nuova revisione indipendente e autorizzazione separata; non è prevista integrazione automatica in main.
