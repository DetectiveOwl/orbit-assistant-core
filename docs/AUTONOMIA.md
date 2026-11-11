# Autonomia di Orbit

Orbit agisce da solo quando puo, chiede quando serve. Le regole stanno nel codice (Permission Manager, Integration Manager, orchestrator), non solo nel prompt.

## Tre categorie
- **A, esecuzione autonoma:** letture e bozze senza effetti (cerca e leggi note, calendario, file autorizzati, web). Nessuna conferma.
- **B, autonomia circoscritta:** creazione di note NUOVE nell'**area bozze** (`ORBIT_AREA_BOZZE`, cartella del vault, sottocartelle incluse). Non sovrascrive mai. Fuori area o con l area spenta (predefinito) vale la C, salvo che l'utente abbia impostato "consenti" per quel livello (allora e B). L area non scavalca mai un "nega".
- **C, conferma obbligatoria:** creare fuori area, ampliare, riscrivere, eliminare, inviare, pubblicare, costi. La conferma vale per una sola operazione con quei parametri. Il risultato di ogni strumento riporta la categoria (`categoria`).

L'integrazione Obsidian resta spenta finche l'utente non la abilita; il vault e in sola lettura salvo area bozze e conferme. Smart Inbox non e toccato.

## Errori
- Ricerca nel vault senza risultati: una sola riformulazione piu larga. Nota non trovata: la risposta riceve i nomi simili.
- Le scritture non si ripetono da sole. Se non ne e riuscita nessuna, frasi come "ho creato la bozza" vengono tolte dalla risposta.
- Errore di login: nessuna escalation verso altri modelli. Messaggio pulito all'utente; il dettaglio tecnico resta nell'evento `errore` (`dettaglio`), nel log e nella diagnostica.

## Stile
Per i compiti operativi (cerca, crea, salva...) il produttore riceve l'istruzione di rispondere in una o due frasi; spiegazioni, documenti, elenchi e confronti non sono limitati.
