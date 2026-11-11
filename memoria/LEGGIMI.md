# Memoria di Orbit (fase 1)

Livello di accesso in **sola lettura** al vault Obsidian. Il vault resta l'unica fonte: nessun file di questo modulo scrive, sposta o cancella note.

**Configurazione.** Il percorso del vault si imposta con la variabile `ORBIT_VAULT_PATH` (se manca, `profilo.js` usa la cartella che contiene il repository quando è un vault Obsidian, poi `Documents\Orbit` dell'utente, anche se Documenti è reindirizzato su OneDrive), letta solo in `config.js`. Nome e profilo dell'utente nei prompt si impostano con `ORBIT_UTENTE`, `ORBIT_UTENTE_PROFILO` e `ORBIT_PAROLE_CORSO` (vedi `profilo.js` e `orbit/.env.example`). All'avvio si controlla che la cartella esista, sia leggibile e contenga `.obsidian`; se no la chat funziona lo stesso e mostra l'errore.

**Indice.** Sta fuori dal vault, in `%LOCALAPPDATA%\Orbit\indice.sqlite` (cambiabile con `ORBIT_INDEX_DIR`), così Obsidian Sync non lo tocca. Contiene titolo, percorso, alias, tag, intestazioni, frontmatter e wikilink, più un indice full text che non conserva il testo delle note: il contenuto viene sempre riletto dai file originali. Si aggiorna da solo e solo per le note cambiate (data di modifica, dimensione e hash). Si può cancellare in qualsiasi momento: `node cli.js ricostruisci`.

**File.** `config.js` percorso e controlli, `analisi.js` lettura di YAML, tag, wikilink ed embed, `indice.js` indice SQLite incrementale, `ricerca.js` motori di ricerca intercambiabili (oggi solo testuale, il semantico per il RAG si aggiunge con `registraMotore`), `memoria.js` funzioni usate da Orbit, `mcp.js` strumenti `cerca_note`, `leggi_nota`, `elenca_note`, `stato_memoria` per Claude Code (da registrare a mano: la vecchia HUD che lo avviava non esiste piu), `cli.js` prove da terminale.

**Un solo retrieval.** Chat, server MCP, strumenti Obsidian di Orbit e CLI cercano con la stessa ricerca per sezioni (`cercaNote`, basata su `cercaSezioni`); le query con `tag:` usano la ricerca per note, l'unica che conosce i tag. `leggi_nota` restituisce la nota intera solo se non si chiede una `sezione` o una `query` (`leggiSezioni`). Dopo una scrittura di Orbit la nota toccata si reindicizza subito (`notificaModifica`); i risultati in cache si ricontrollano sui file da cui vengono.

**Prove rapide.** Da questa cartella: `node cli.js stato`, `node cli.js cerca "rouche capelli"`, `node cli.js cerca "tag:analisi"`, `node cli.js leggi piano-di-studio`, `node cli.js sezioni scadenze/parziali.md "Stato del ripasso"`.
