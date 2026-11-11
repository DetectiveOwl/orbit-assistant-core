# TS-3 — writer Windows, modello pratico cooperante

Modulo sperimentale separato da Orbit e dalla skill Inbox. Non effettua chiamate AI e non interpreta semanticamente le note. Non è approvato per il vault reale: richiede revisione indipendente e successiva autorizzazione di integrazione.

## Perimetro

Presuppone che le istanze Orbit/Claude che scrivono usino lo stesso protocollo e il medesimo mutex del vault. Controlla le modifiche accidentali rilevate, i percorsi, gli hash e i collegamenti già presenti. Non garantisce difesa da processi ostili che creino intenzionalmente hardlink durante la scrittura, ignorino il coordinamento, alterino il processo o interferiscano con gli stessi o maggiori privilegi utente. La vecchia diagnostica su tali minacce non diventa un PASS della sicurezza.

Richiede Windows x64 e NTFS locale. Il backend attuale conserva una fence obbligatoria per staging sintetici `orbit-smart-inbox-ts3-<GUID>`: non è attivabile direttamente su percorsi operativi. Non offre una CLI di produzione o un collegamento automatico alla UI/skill.

## Componenti

- `writer.js`: funzioni pure `prepara(piano, snapshot)` e `creaHost({rootId, rootIdentity, backend})`; riusa planner, reader e policy TS1/2 senza modificarli.
- `windows/Handles.cs`: primitive Windows già validate per aperture relative, identità, esclusione delle scritture normali, rifiuto reparse/hardlink preesistenti, creazione esclusiva e rename senza replace.
- `windows/Engine.cs`: mutex, controlli preflight, backup verificati, journal, append, archiviazione, ripristino e recovery.
- I file in `tests/` forniscono il trasporto nativo **di test**, fixture sintetiche, guardia, Job Object e runner. Non sono un servizio o una nuova infrastruttura operativa.

Il codice Node cura piano, preview e consenso. Si riusa il piccolo backend C# Windows esistente perché espone gli handle e il mutex già provati, senza pacchetti, installazioni o un protocollo nuovo di lock-file con gestione di PID/stale lock. La compilazione Add-Type avviene esclusivamente nel processo temporaneo di test.

## Consenso e ammissibilità

`prepara` richiede un piano TS1/2 valido e completo, una decisione per ogni sorgente, nessuna duplicazione di id/sorgenti/operazioni e metadati delle note coerenti con i byte. Produce preview deterministica di byte e hash. BLOCK e CONFIRM richiedono revisione del piano: il writer non li converte in approvazioni.

L'host fidato mostra la preview e chiama `confermaDaHost` specificando azione e operazioni autorizzate. La capability è legata a quella preview/root e non è serializzabile; `approved:true` del modello non la sostituisce. Le mosse delle sorgenti richiedono una lista `archivia` distinta dal consenso alle modifiche.

Azioni: `apply`, `inspect`, `recover`, `rollback`. Recovery di uno stato parziale richiede conferma separata legata a hash e identità osservati. Chi emette la capability e chi implementa il backend sono componenti fidati, non dati controllabili dal modello. Questa API non sostituisce un futuro controllo UI di consenso.

## Operazioni minime

CREATE copia esattamente i byte UTF-8 della sorgente. MERGE accoda soltanto unità testuali piatte autorizzate: mantiene l'intero prefisso del target, wikilink e terminatori; non riscrive frontmatter o sezioni. Un merge con strutture non supportate viene respinto e la sorgente rimane intatta. NOOP non modifica note.

MERGE e NOOP rifiutano unità indentate nell'intera sorgente o nel relativo target, anche se eliminate dalle aggiunte per deduplicazione: il confronto piatto non rappresenta genitori di liste e continuazioni. Il diniego avviene prima del backend e impedisce anche l'archiviazione. CREATE non applica deduplicazione e conserva il comportamento di copia byte-esatta, incluse le strutture annidate.

Prima di toccare le note, il backend acquisisce un mutex Windows `Local\\OrbitSmartInbox-<volume-fileId-root>`, controlla identità della root, directory/catalogo, hash delle sorgenti e delle destinazioni. Tutte le istanze cooperative nella stessa sessione Windows devono usare questo mutex; non è un coordinamento fra sessioni/utenti differenti o verso strumenti che scrivano direttamente ignorandolo. Il mutex abbandonato viene acquisito soltanto per riconciliare lo stato dai file, non per assumere che la precedente operazione sia finita.

Backup originali e checkpoint di ripristino vengono copiati e verificati per hash prima delle modifiche. Risiedono in una root tecnica esplicita, esterna al vault e sullo stesso volume, con manifest del piano e record immutabili numerati/hash-chain. Le copie verificate rimangono aperte durante l'operazione. I file temporanei incompleti vengono conservati, mai interpretati come record pubblicati. Nessun backup originale viene sovrascritto.

Archiviazione: soltanto dopo verifica degli output e con consenso esplicito. La sorgente viene spostata senza replace in un file `.input` nell'area tecnica, non cancellata definitivamente o lasciata all'indicizzazione del vault.

## Errori e ripristino

Un errore ordinario prima dell'archiviazione tenta di ripristinare le sole modifiche effettuate dalla chiamata corrente. Un append può essere troncato ai byte precedenti **solo** con backup verificato, identità invariata e contenuto riconosciuto come prefisso della modifica attesa. Una nuova nota viene spostata in recupero tecnico, conservandone i byte. Il risultato resta FAIL, con `restoration` e percorso del manifest: il recupero non converte un errore in PASS.

Un errore durante l'archiviazione può lasciare output già applicati e sorgenti ripartite fra vault/archivio. Il manifest e gli intent registrati permettono inspect/replay senza una seconda append. Una collisione nell'archivio non viene sovrascritta. Non viene promessa atomicità di un batch di più file.

Un processo interrotto può lasciare una scrittura parziale. `inspect` descrive lo stato; `recover` completa esclusivamente i byte mancanti riconosciuti e autorizzati. Un contenuto utente diverso viene preservato e segnalato come conflitto.

Se un errore ordinario durante recovery ripristina il parziale osservato, un singolo record `partial-restored` conserva identità e hash di quel parziale, invalidando gli esiti del tentativo fallito. Un nuovo inspect e un nuovo consenso permettono di riprendere MERGE o CREATE. Il record `compensated`, usato quando si torna allo stato iniziale, continua invece ad azzerare la provenienza dei tentativi precedenti: non autorizza come proprie modifiche utente successive.

Rollback controlla hash e identità post-apply prima di qualsiasi modifica, salva la versione corrente e ripristina gli originali. Una CREATE viene spostata nell'area di recupero; gli input archiviati vengono ricopiati con CREATE esclusivo, conservando anche l'archivio. La copia ripristinata può avere un nuovo fileID. Se il ripristino della sorgente fallisce, la copia incompleta è spostata in recupero e l'archivio originale resta disponibile.

Se una scrittura o la persistenza del journal continuano a fallire (per esempio disco pieno persistente), l'esito indica `RECOVERY_REQUIRED` o `RESTORED_JOURNAL_UNCONFIRMED`. Si conserva il materiale di recupero e si interrompe: non si sovrascrivono note per ottenere un risultato positivo. Non sono garantiti power-loss, guasti hardware o recovery contro manomissioni ostili del filesystem.

## Test

Runner dedicato: `tests/run-ts3-windows.ps1`. Copia un manifest esplicito verificato in TEMP, usa ambiente sintetico senza credenziali, guardia preimport, Job Object e watchdog finiti. Esegue controlli di sintassi e soltanto TS1/2/3 con mock semantici; nessun backend operativo, database, AI o voce.

I canarini richiesti mantengono verifiche di isolamento, percorsi, junction preesistenti, hardlink preesistenti, accesso esclusivo, rename/no-replace e processi. La creazione ostile di hardlink durante il pin e il vecchio studio RWH sono classificati come limiti diagnostici esclusi dal nuovo modello: non vengono rieseguiti, contati come PASS o usati come garanzie.

## Prima di TS4/TS5

Servono revisione indipendente sul modello pratico, autorizzazione separata all'integrazione, host di consenso con preview e gestione dei conflitti, scelta esplicita della root tecnica e dei percorsi reali, policy di conservazione dei backup e una piccola prova manuale autorizzata. La fence sintetica non va rimossa automaticamente. Nessuna prova sul vero `to sort` è stata eseguita. TS4/5/6 e ulteriori ottimizzazioni restano fuori da questo cambiamento.

Le capability vivono nel processo host. I test di crash interrompono il backend nativo proprietario del mutex, conservando piano/snapshot nell'host di test. La riapertura guidata dopo un riavvio completo dell'host richiederà la disponibilità del piano/snapshot originale e una nuova conferma; persistenza e UI di tale flusso appartengono alla successiva integrazione. I backup e il manifest rimangono disponibili e non autorizzano da soli scritture automatiche.
