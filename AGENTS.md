# Orbit: istruzioni condivise per gli agenti di sviluppo

Valgono per Claude Code e Codex nel repository `.orbit-hud`. Le istruzioni di sviluppo sono in `CLAUDE.md`; qui solo le regole comuni. In italiano.

- **Baseline di riferimento (storica, non un HEAD da imporre):** commit `f41749f`, tag `orbit-v0.1-baseline-2026-10-21`. Prima di lavorare verifica lo stato reale con `git fetch`, `git status`, `git worktree list` e confronta main con origin/main.
- Claude Code e Codex sono entrambi autorizzati a sviluppare. Ogni incarico ha un responsabile esplicito; un solo agente modifica lo stesso componente alla volta.
- Lavori paralleli in branch e worktree separati (`claude/<tema>`, `codex/<tema>`), da main aggiornato. Non toccare i worktree altrui.
- Nessun merge, push o modifica a main senza autorizzazione esplicita dell'utente.
- Mai cancellare in automatico branch, worktree o backup.
- Il vault Obsidian è in sola lettura salvo autorizzazioni esplicite e circoscritte; mai toccare `.obsidian`.
- Test con dati sintetici e percorsi isolati quando c'è di mezzo materiale personale o operazioni distruttive.
- Nessuna API a consumo senza autorizzazione.
- Metodo MVP: prima il minimo funzionante e verificato; le migliorie future si documentano in Obsidian e non si implementano da sole.
- Distingui sempre ciò che è verificato da ciò che è mock o non eseguito.

Riferimenti: `CLAUDE.md`, `docs/GIT-COLLABORAZIONE.md`, `risultati/handoff-baseline-v0.1-2026-10-21.md` (documento locale, non necessariamente presente negli altri clone).
