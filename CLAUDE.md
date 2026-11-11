# Orbit: istruzioni di sviluppo

Valgono per chi sviluppa il codice di questo repository (non per l'assistente di studio nel vault). In italiano, con termini tecnici inglesi quando servono.

## Metodo
- Prima un MVP semplice, utilizzabile e verificato. Niente overengineering, controlli sproporzionati o refactoring non richiesti.
- Prima dell'attivazione si risolvono solo i problemi realmente bloccanti, in particolare sicurezza e integrità dei dati.
- Test mirati, riuso del codice esistente, consumo contenuto dei crediti Claude.

## Migliorie future
- Ogni funzionalità ha nel vault Obsidian una nota "<Funzione> — Migliorie future", collegata al registro `progetti/Orbit/migliorie.md` e alle note pertinenti.
- Le migliorie non essenziali si annotano lì e non si implementano da sole: si riprendono solo quando l'utente lo chiede.

## Strumenti e limiti
- Claude Code e Codex sono entrambi autorizzati a implementare. Regole di collaborazione in `AGENTS.md` del vault e in `docs/GIT-COLLABORAZIONE.md`: un responsabile per incarico, un solo agente per componente, branch e worktree separati, nessun merge o push senza autorizzazione.
- Modello massimo Opus 5.5 con ragionamento massimo High; preferire Sonnet o Haiku quando bastano.
- Nessun push, merge non autorizzato o modifica a dati personali fuori dal perimetro approvato.
