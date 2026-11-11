# Skill di esempio: piano-oggi

Questa è una copia **anonima e generica** della skill `piano-oggi`. Non è attiva da sola: copiarla qui non basta a farla funzionare.

## Come si configura

1. **Copia il file** `SKILL.md` nel tuo vault Obsidian, in `.claude/skills/piano-oggi/SKILL.md`. Orbit legge le istruzioni da lì, in sola lettura (vedi `orbit/skills/piano-oggi.js`). Se il file manca, Orbit prepara comunque il piano con le regole di base, senza le tue istruzioni.
2. **Prepara le note che la skill legge**, con questa struttura nel vault:
   - `scadenze/piano-di-studio.md`: una sezione "Come funziona il piano" e una sezione "Piano giorno per giorno" con una tabella le cui righe iniziano con il giorno e la data (per esempio `| Lun 12 | ... |`).
   - `scadenze/parziali.md`: una sezione "Stato del ripasso" con una riga per argomento (fatto, parziale, da fare).
   - `corsi/<materia>/INDICE.md`: in quali pagine della dispensa si trova ogni argomento.
   Un esempio completo e inventato di queste note è in `esempi/benchmark/vault/`.
3. **Chiedi il piano a Orbit** con una frase esplicita ("fammi il piano di oggi", "piano-oggi"). Il piano viene salvato in `outputs/piano-AAAA-MM-GG.md` con lo strumento di creazione note di Orbit, quindi secondo i permessi che hai scelto in Impostazioni e integrazioni (può chiedere conferma).

## Cosa adattare

- I percorsi delle note (`scadenze/...`, `corsi/...`, `outputs/...`) se il tuo vault è organizzato diversamente: vanno cambiati sia nella skill sia, se usi un'altra struttura, nelle note che Orbit deve trovare.
- Il tono e il numero massimo di priorità (nella sezione 3).
- Il nome con cui Orbit si rivolge a te si imposta con `ORBIT_UTENTE` nel file `.env` (vedi il README).
