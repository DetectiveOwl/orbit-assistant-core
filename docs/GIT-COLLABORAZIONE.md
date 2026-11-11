# Git per Orbit: branch, worktree e collaborazione tra agenti

Questo documento descrive come si lavora su Orbit con Git quando più agenti (per esempio Claude Code e Codex) e una persona intervengono sullo stesso codice. È una strategia da seguire, non un'automazione: nessun comando qui sotto viene eseguito da solo.

La radice del repository è la cartella `.orbit-hud`. Il vault Obsidian che la contiene (o che le sta accanto) **non** fa parte del repository e Git non va mai inizializzato nella radice del vault.

## Branch

| Branch | Scopo | Chi lo usa di solito |
| :-- | :-- | :-- |
| `main` | Solo versioni stabili e verificate (test e controlli statici superati). È il punto di ripristino affidabile: non si lavora direttamente qui | nessuno scrive a mano, si integra soltanto |
| `claude/performance` | Backend, pipeline AI, router, Quality Gate, memoria, prestazioni, orchestrazione dei modelli | Claude Code |
| `codex/interface` | Frontend, interfaccia grafica, animazioni, componenti visivi, esperienza utente | Codex |

I nomi indicano le responsabilità iniziali, non permessi esclusivi: qualunque agente può lavorare su qualunque area, ma lo fa su un branch proprio e dopo aver controllato dove sta lavorando l'altro. Per singoli interventi si possono creare branch dedicati con prefisso dell'agente o del tema (`claude/fix-calendario`, `codex/tema-scuro`). I branch di sviluppo si creano solo quando serve il lavoro, non in anticipo.

## Regole di collaborazione

1. **Prima di iniziare** ogni agente controlla lo stato: `git status`, `git branch --show-current`, `git log --oneline -5` e l'elenco dei worktree (`git worktree list`). Se la directory ha modifiche che non sono sue, si ferma e le segnala.
2. **Nessuno sovrascrive il lavoro dell'altro.** Non si usano `git reset --hard`, `git clean -fd`, `git checkout -- <file>` su modifiche altrui, `git push --force` né la cancellazione di branch senza aver verificato che non contengano commit non integrati (`git log main..<branch>`).
3. **Ogni intervento importante ha un commit identificabile**, con messaggio nel formato `tipo(ambito): descrizione` (per esempio `fix(router): non scalare a Opus per richieste semplici`). Commit piccoli, uno per scopo.
4. **Prima di toccare file condivisi** (`orbit/orchestrator.js`, `orbit/server.js`, `orbit/config.js`, `orbit/public/app.js`, `package.json`) si guarda chi li ha modificati di recente (`git log --oneline -5 -- <file>`) e si verifica chi li importa. Le modifiche ai file condivisi restano piccole e mirate.
5. **Si testa prima di integrare**: `npm run verifica` (controlli statici più suite completa) deve passare sul branch, non solo su `main`.
6. **`main` resta stabile.** Ci si arriva solo con un'integrazione verificata (vedi sotto).
7. **I conflitti si risolvono a mano e in modo esplicito**, leggendo entrambe le versioni. Mai scegliere in blocco "la mia" o "la tua" senza averle confrontate.
8. **Niente merge automatici non verificati.** Si integra con `--no-commit`, si provano i test, e solo allora si conferma.

## Worktree: una directory per agente

Due agenti nella stessa directory condividono i file: se uno cambia branch, l'altro si ritrova il codice sotto i piedi. La soluzione è un **worktree** per agente: una directory di lavoro separata, con il proprio branch, che condivide solo la cronologia di Git.

I worktree vanno **fuori dal vault** (altrimenti Obsidian li indicizzerebbe e potrebbero finire in Obsidian Sync) e non contengono copie dei dati privati: la cartella `privato/` è esclusa da Git, quindi in un worktree nuovo semplicemente non esiste.

Esempio (da eseguire solo quando serve il lavoro in parallelo; non fa parte della preparazione iniziale). I percorsi sono segnaposto: usa una cartella tua, fuori dal vault.

```bash
# dalla radice del repository (la cartella .orbit-hud)
git worktree add ../../orbit-worktrees/claude-performance -b claude/performance main
git worktree add ../../orbit-worktrees/codex-interface   -b codex/interface   main
git worktree list
```

Su Windows conviene un percorso assoluto fuori dalla cartella Documenti del vault, per esempio `C:\orbit-worktrees\claude-performance`. Un branch può essere aperto in un solo worktree alla volta: Git lo impedisce.

Per rimuovere un worktree a lavoro integrato (la cartella viene eliminata solo se non ha modifiche non salvate):

```bash
git worktree remove ../../orbit-worktrees/claude-performance
```

### Isolare anche l'esecuzione, non solo i file

Git isola il codice, non l'esecuzione di Orbit. Due istanze di Orbit avviate da worktree diversi condividono, se non si fa nulla, **porta, database, token Google, indice della memoria e modelli vocali**. Per provare un worktree senza disturbare l'altro:

| Risorsa | Come separarla |
| :-- | :-- |
| Porta del server | `ORBIT_PORT` diversa per worktree (per esempio 4790 e 4791; 4778 resta all'istanza principale) |
| Database, audit, token Google, `cc-cwd` | `ORBIT_DATA_DIR` diversa per worktree (non condividere il database di un'istanza in uso: è SQLite e due processi con modifiche diverse si danneggiano a vicenda) |
| Indice della memoria | `ORBIT_INDEX_DIR` diversa per worktree |
| Vault | `ORBIT_VAULT_PATH` esplicito: fuori dal vault l'autorilevamento (cartella che contiene `.orbit-hud`) non può funzionare. Per i test usare una copia o un vault di prova, mai scritture sul vault reale |
| Profilo locale (`privato/orbit.env`) | Non esiste nel worktree. Se serve, `ORBIT_LOCAL_ENV` punta al file originale (solo lettura) oppure si impostano le variabili a mano |
| Modelli vocali (Whisper, Vosk, Piper) | Possono restare condivisi in sola lettura con `ORBIT_STT_DIR`; il processo Whisper sceglie da solo una porta libera |
| Credenziali Google | Non copiarle nei worktree: per le prove usare mock o un `ORBIT_DATA_DIR` senza token |

I test automatici (`npm test`) usano mock e cartelle temporanee e non richiedono nessuna di queste cose.

## Checkpoint e rollback (solo comandi non distruttivi)

**Creare un checkpoint prima di una modifica importante.** Un tag leggero sul commit corrente, senza spostare nulla:

```bash
git status                      # deve essere pulito, altrimenti si fa prima un commit
git tag checkpoint/2026-10-12-prima-del-router
```

Quando una versione è verificata (test superati e prova manuale) si marca come stabile e si lascia `main` su quel commit:

```bash
git tag stabile/2026-10-12
```

**Trovare l'ultima versione funzionante:** `git tag --list "stabile/*"` e `git log main --oneline -10`.

**Confrontare due versioni:**

```bash
git log --oneline stabile/2026-10-12..claude/performance    # cosa c'è in più
git diff --stat stabile/2026-10-12 claude/performance       # quali file cambiano
git diff stabile/2026-10-12 claude/performance -- orbit/ai/router/router.js
```

**Ripristinare una versione precedente senza perdere nulla:**

```bash
git switch -c ripristino/da-stabile-2026-10-12 stabile/2026-10-12   # nuovo branch dal tag, il resto resta intatto
git restore --source=stabile/2026-10-12 -- orbit/ai/router/router.js # solo un file, nel branch corrente
git revert <commit>                                                   # annulla un commit con un nuovo commit (la storia resta)
```

Si evitano `git reset --hard`, `git clean -fd` e la cancellazione di branch: se un giorno servissero davvero, prima si controlla con `git status`, `git stash list` e `git log main..<branch>` che non si perdano modifiche, e si fa un tag di sicurezza.

**Integrare modifiche verificate in `main`:**

```bash
git switch main                              # dal worktree di main, mai da quelli degli agenti
git merge --no-ff --no-commit claude/performance
npm run verifica                             # controlli statici e suite completa
# se tutto passa:
git commit -m "merge: ottimizzazioni delle prestazioni verificate"
git tag stabile/AAAA-MM-GG
# se qualcosa non va:
git merge --abort
```

Se l'integrazione produce conflitti, si fermano le operazioni, si leggono i file in conflitto (`git diff --name-only --diff-filter=U`) e si risolvono a mano.

## Cosa non fa questa strategia

Non attiva nessuna integrazione continua né automazione di Git, e non collega il repository a GitHub: il remoto e il primo push sono scelte della persona (vedi il README).
