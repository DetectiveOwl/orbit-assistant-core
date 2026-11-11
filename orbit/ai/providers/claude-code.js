'use strict';
const { performance } = require('node:perf_hooks');
// ClaudeCodeProvider: adapter del contratto ModelExecutionProvider per Claude Code, con il login dell'abbonamento dell'utente.
// Nessuna chiave API, nessun credito: lancia il binario `claude` ORIGINALE e non modificato con `claude -p` e legge solo il suo output JSON.
// Orbit non vede, non copia e non conserva mai token o credenziali: il login claude.ai e gestito da Claude Code.
//
// ---- Scheda dell'adapter ----
// Eseguibile        claude (claude.exe installato da npm, risolto dal PATH; ORBIT_CLAUDE per un percorso diverso)
// Autenticazione    login claude.ai dell'abbonamento, controllato con `claude auth status` (authMethod claude.ai, apiProvider firstParty)
// Modelli           alias haiku, sonnet, opus (--model); i nomi completi si impostano in ORBIT_MODEL_*. La disponibilita nel piano si prova con listAvailableModels({ probe: true })
// Esecuzione        claude -p, prompt da stdin, un solo turno, strumenti spenti (--tools ""), permessi dontAsk, nessuna sessione salvata
// Output            JSON con result, usage (token reali), modelUsage, total_cost_usd (equivalente a listino, non addebitato), stop_reason
// Codici di uscita  0 = ok; diverso da 0 con is_error nel JSON = errore classificato (login, limiti, modello, sovraccarico, output troppo lungo)
// Timeout           per chiamata, con kill dell'albero di processi; cancellazione con cancelExecution(id) o con il segnale di annullamento
// Limiti d'uso      quelli dell'abbonamento: Claude Code non li espone in anticipo, compaiono solo come errore quando si raggiungono
// Routing           compatibile: il modello si sceglie per chiamata; ogni chiamata e indipendente
//
// Garanzie contro la fatturazione API (verificate dai test):
//  - dall'ambiente del processo figlio vengono rimosse ANTHROPIC_*, CLAUDE_CODE_USE_*, CLAUDE_CODE_OAUTH_TOKEN, AWS_BEARER_TOKEN_BEDROCK e simili;
//  - non si usa mai --bare (richiede una chiave API);
//  - prima di usarlo si controlla che il login sia claude.ai / firstParty; altrimenti Orbit si rifiuta di lavorare;
//  - il processo parte senza shell, con argomenti strutturati: il testo dell'utente passa solo da stdin.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OrbitError, errori } = require('../errors');

const IS_WIN = process.platform === 'win32';
const ALIAS_SICURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;     // alias o nome completo: nessun carattere speciale
const PREFISSI_VIETATI = [/^ANTHROPIC_/i, /^CLAUDE_CODE_USE_/i, /^CLAUDE_CODE_OAUTH_TOKEN$/i, /^AWS_BEARER_TOKEN_BEDROCK$/i, /^CLAUDE_CODE_SKIP_.*AUTH$/i];
const SISTEMA_BREVE = 'Sei il motore di testo di Orbit. Segui le istruzioni nel messaggio e rispondi solo con il testo richiesto.';
const ALIAS_MODELLI = ['haiku', 'sonnet', 'opus'];
const MAX_OUTPUT_BYTE = 2 * 1024 * 1024;                      // oltre, il processo viene fermato

// Ambiente del figlio: quello di Orbit senza nessuna variabile che possa far usare l'API a pagamento o un altro provider.
function ambientePulito(env = process.env) {
  const out = {}, rimosse = [];
  for (const [k, v] of Object.entries(env)) {
    if (PREFISSI_VIETATI.some(re => re.test(k))) { rimosse.push(k); continue; }
    out[k] = v;
  }
  return { env: out, rimosse };
}

// Trova l'eseguibile reale senza passare dalla shell. Su Windows lo shim npm `claude.cmd` punta a claude.exe: si usa direttamente quello.
function risolviEseguibile(bin, envPath = process.env.PATH || process.env.Path || '') {
  if (!IS_WIN) return { exe: bin, shell: false };
  const haPercorso = /[\\/]/.test(bin);
  const candidati = haPercorso ? [bin] : envPath.split(';').filter(Boolean).flatMap(d => [path.join(d, bin + '.exe'), path.join(d, bin + '.cmd')]);
  for (const c of candidati) {
    if (!fs.existsSync(c)) continue;
    if (/\.exe$/i.test(c) || !/\.(cmd|bat)$/i.test(c)) return { exe: c, shell: false };
    try {
      const m = fs.readFileSync(c, 'utf8').match(/"%dp0%\\([^"\r\n]+?\.exe)"/i);
      if (m) { const exe = path.join(path.dirname(c), m[1]); if (fs.existsSync(exe)) return { exe, shell: false }; }
    } catch (e) { /* si ricade sulla shell */ }
    return { exe: c, shell: true };        // shim non riconosciuto: unica eccezione, con soli argomenti fissi e validati
  }
  return { exe: bin, shell: false };
}

function quota(a) { return /[\s()&|<>^"%!]/.test(a) || a === '' ? '"' + a.replace(/"/g, '') + '"' : a; }

// Trasforma i messaggi in un unico prompt: `-p` riceve un solo testo.
function costruisciPrompt({ system, messages, maxTokens }) {
  const parti = [];
  const limite = maxTokens ? '\nLunghezza: resta entro circa ' + Math.max(20, Math.round(maxTokens * 0.55)) + ' parole.' : '';
  if (system || limite) parti.push('<istruzioni>\n' + (system || '') + limite + '\n</istruzioni>');
  const storia = messages.slice(0, -1);
  if (storia.length) {
    parti.push('<conversazione_precedente>\n' + storia.map(m => (m.role === 'user' ? 'Utente: ' : 'Orbit: ') + m.content).join('\n\n') + '\n</conversazione_precedente>');
  }
  const ultimo = messages[messages.length - 1];
  parti.push((storia.length ? '<messaggio_corrente>\n' : '') + (ultimo ? ultimo.content : '') + (storia.length ? '\n</messaggio_corrente>' : ''));
  return parti.join('\n\n');
}

// Riconosce i casi in cui l'abbonamento e arrivato al limite o il login non c'e, per fermarsi senza insistere.
function classificaErrore(testo, codiceUscita) {
  const t = String(testo || '');
  const con = e => Object.assign(e, { codiceUscita });
  if (/exceeded the .{0,40}output token maximum/i.test(t)) return con(new OrbitError('OUTPUT_TROPPO_LUNGO', 'La risposta di Claude e uscita dal limite di lunghezza ed e stata scartata.', {}));
  // Il login scaduto non si risolve cambiando modello, anche quando il messaggio suggerisce "try again".
  if (/not logged in|please run \/login|login expired|invalid api key|authentication|failed to refresh\s+(?:oauth\s+)?(?:access\s+)?token|\boauth\s+(?:(?:access|refresh)\s+)?token\s+(?:has\s+|is\s+)?expired\b|\binvalid\s+bearer\s+token\b|\bbearer\s+token\s+(?:has\s+|is\s+)?expired\b|\b401\b|\bunauthorized\b/i.test(t)) {
    return con(new OrbitError('NOT_LOGGED_IN', 'Claude Code non e collegato al tuo abbonamento. Apri un terminale ed esegui "claude", poi /login.', { fatal: true }));
  }
  if (/usage limit|limit reached|rate limit|too many requests|quota|resets? at|out of (extra )?usage|credit balance/i.test(t)) {
    return con(new OrbitError('LIMITE_ABBONAMENTO', 'Hai raggiunto i limiti del tuo abbonamento Claude: Orbit si ferma e non acquista nulla. Riprova quando i limiti si azzerano. (' + t.slice(0, 160).replace(/\s+/g, ' ') + ')', { fatal: true }));
  }
  if (/overloaded|temporar|try again|503|529|500/i.test(t)) return con(new OrbitError('OVERLOADED', 'Il servizio Claude e momentaneamente occupato.', { retryable: true }));
  if (/selected model|may not exist|model.*(not found|unknown|invalid|not available|does not exist)|unknown model/i.test(t)) return con(new OrbitError('MODEL_NOT_FOUND', 'Il modello richiesto non e disponibile con il tuo piano.'));
  return con(new OrbitError('BAD_RESPONSE', 'Claude Code ha restituito un errore (codice ' + codiceUscita + '): ' + t.slice(0, 200).replace(/\s+/g, ' '), {}));
}

let contatore = 0;
const nuovoIdEsecuzione = () => 'exec_' + Date.now().toString(36) + '_' + (++contatore);

class ClaudeCodeProvider {
  // bin/binArgs sono iniettabili nei test (un falso `claude`). cwd e una cartella neutra, fuori dal vault: non si caricano CLAUDE.md, skill o hook del vault.
  constructor({ bin = process.env.ORBIT_CLAUDE || 'claude', binArgs = [], cwd, envBase, maxOutputByte = MAX_OUTPUT_BYTE } = {}) {
    this.id = 'claude-code';
    this.bin = bin; this.binArgs = binArgs; this.cwd = cwd; this.envBase = envBase || process.env;
    this.maxOutputByte = maxOutputByte;
    this.sessione = null; this.sessioneTs = 0;
    this.elencoIndicativo = true;                      // senza probe l'elenco modelli contiene solo alias non verificati
    this.attive = new Map();                           // executionId -> { termina }
    this.verificaModelli = null;                       // ultimo risultato di listAvailableModels({ probe: true })
    const percorso = (envBase || process.env).PATH || (envBase || process.env).Path;
    const r = binArgs.length || path.isAbsolute(bin) ? { exe: bin, shell: false } : risolviEseguibile(bin, percorso);
    this.exe = r.exe; this.usaShell = r.shell;
  }

  _preparaCwd() { if (this.cwd) { try { fs.mkdirSync(this.cwd, { recursive: true }); } catch (e) { /* si usa la cartella corrente */ } } }

  // Esegue il processo e raccoglie stdout, stderr e codice di uscita separatamente.
  _esegui(args, { stdin, signal, timeoutMs, env, executionId, onPerformance }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(errori.aborted());
      if (executionId && this.attive.has(executionId)) return reject(new OrbitError('DUPLICATA', 'Esiste gia un\'esecuzione con lo stesso identificativo: non avvio processi duplicati.', { fatal: true }));
      this._preparaCwd();
      const tutti = this.binArgs.concat(args);
      let child;
      try {
        child = this.usaShell
          ? spawn([quota(this.exe)].concat(tutti.map(quota)).join(' '), { shell: true, cwd: this.cwd, env, windowsHide: true })
          : spawn(this.exe, tutti, { cwd: this.cwd, env, windowsHide: true });
      } catch (e) { return reject(new OrbitError('NO_CLAUDE', 'Non riesco ad avviare Claude Code: ' + e.message, { fatal: true })); }
      const t0 = performance.now();
      let out = '', err = '', byte = 0, chiuso = false, primo = false;
      const fine = (fn, v) => {
        if (chiuso) return; chiuso = true; clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (executionId) this.attive.delete(executionId);
        fn(v);
      };
      const uccidi = () => { try { if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); else child.kill('SIGKILL'); } catch (e) { /* gia terminato */ } };
      const timer = timeoutMs ? setTimeout(() => { uccidi(); fine(reject, errori.timeout()); }, timeoutMs) : null;
      const onAbort = () => { uccidi(); fine(reject, errori.aborted()); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (executionId) this.attive.set(executionId, { termina: () => { uccidi(); fine(reject, errori.aborted()); }, pid: child.pid });
      child.stdout.on('data', d => {
        if (!primo) { primo = true; try { onPerformance?.('primo_output'); } catch (e) { /* tracing non blocca il provider */ } }
        byte += d.length;
        if (byte > this.maxOutputByte) { uccidi(); return fine(reject, new OrbitError('OUTPUT_ENORME', 'Claude Code ha prodotto troppo output (oltre ' + Math.round(this.maxOutputByte / 1024) + ' KB): processo fermato.', {})); }
        out += d.toString('utf8');
      });
      child.stderr.on('data', d => { if (err.length < 20000) err += d.toString('utf8'); });
      child.on('error', e => fine(reject, new OrbitError('NO_CLAUDE', e.code === 'ENOENT' ? 'Claude Code non trovato. Controlla che il comando "claude" funzioni da un terminale (o imposta ORBIT_CLAUDE).' : 'Errore nell\'avvio di Claude Code: ' + e.message, { fatal: true })));
      child.on('close', code => fine(resolve, { out, err, code, durataMs: performance.now() - t0, pid: child.pid }));
      child.stdin.on('error', () => { /* il processo puo chiudersi prima di leggere */ });
      child.stdin.end(stdin || '', 'utf8');
    });
  }

  cancelExecution(executionId) {
    const e = this.attive.get(executionId);
    if (!e) return false;
    e.termina();
    return true;
  }

  // strumentiWeb: unica eccezione a "strumenti spenti": solo WebSearch e WebFetch (sola lettura, nessun file, nessuna shell),
  // usati dall'integrazione web. Tutto il resto resta spento e i permessi restano "dontAsk": cio che non e elencato e negato.
  async executeTask({ executionId, model, system, messages, maxTokens, signal, timeoutMs, strumentiWeb = false, onPerformance }) {
    if (!model || !ALIAS_SICURO.test(model)) throw new OrbitError('MODEL_NOT_FOUND', 'Nome del modello non valido.');
    const id = executionId || nuovoIdEsecuzione();
    const t0 = performance.now();
    const { env } = ambientePulito(this.envBase);
    // Attenzione: con questo tetto Claude Code SCARTA l'intera risposta se lo supera (errore, non troncamento).
    // Quindi il tetto e largo e la brevita si chiede nel prompt, non con il limite duro.
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.max((maxTokens || 0) * 3, 4096));
    const strumenti = strumentiWeb ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
    const args = ['-p', '--output-format', 'json', '--model', model].concat(strumenti, ['--permission-mode', 'dontAsk',
      '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence', '--strict-mcp-config', '--system-prompt', SISTEMA_BREVE]);
    try { onPerformance?.('processo_scelto'); } catch (e) { /* tracing non blocca il provider */ }
    const r = await this._esegui(args, { stdin: costruisciPrompt({ system, messages, maxTokens }), signal, timeoutMs, env, executionId: id, onPerformance });
    let j = null;
    try { j = JSON.parse(r.out); } catch (e) { /* non e JSON */ }
    if (Array.isArray(j)) j = j.filter(x => x && x.type === 'result').pop() || null;
    if (!j || j.is_error || r.code !== 0) throw classificaErrore((j && j.result) || r.err || r.out, r.code);
    const u = j.usage || {};
    const entrata = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const modelloUsato = j.modelUsage ? Object.keys(j.modelUsage)[0] : model;
    return {
      text: typeof j.result === 'string' ? j.result : '',
      usage: { inputTokens: Number.isFinite(u.input_tokens) ? entrata : null, outputTokens: Number.isFinite(u.output_tokens) ? u.output_tokens : null },
      stopReason: j.stop_reason === 'max_tokens' || /max_tokens|max_output/i.test(j.terminal_reason || '') ? 'max_tokens' : (j.stop_reason || null),
      model: modelloUsato || model,
      modelRequested: model, modelReported: j.model || (j.modelUsage ? Object.keys(j.modelUsage)[0] : null) || null,
      modelsReported: [...new Set([j.model, ...Object.keys(j.modelUsage || {})].filter(Boolean))],
      latencyMs: performance.now() - t0,
      costoEquivalente: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null,    // stima a listino API, NON fatturata con l'abbonamento
      provider: this.id, executionId: id,
      processo: { codiceUscita: r.code, durataMs: r.durataMs, pid: r.pid }
    };
  }
  complete(req) { return this.executeTask(req); }       // nome storico usato dal gateway e dai test

  // Senza probe l'elenco contiene solo gli alias, NON verificati. Con probe ogni alias e provato con una chiamata minima (consuma un po' di limiti).
  async listAvailableModels({ probe = false, signal } = {}) {
    if (!probe) {
      const noti = this.verificaModelli ? new Map(this.verificaModelli.map(m => [m.id, m])) : new Map();
      return ALIAS_MODELLI.map(id => noti.get(id) || { id, nome: id + ' (alias Claude Code)', verificato: false, disponibile: null });
    }
    const out = [];
    for (const id of ALIAS_MODELLI) {
      const t0 = Date.now();
      try {
        const r = await this.executeTask({ model: id, system: null, messages: [{ role: 'user', content: 'Rispondi solo con la parola: ok' }], maxTokens: 40, signal, timeoutMs: 60000 });
        out.push({ id, nome: id, verificato: true, disponibile: true, modelloEffettivo: r.model, latenzaMs: Date.now() - t0, token: r.usage });
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        if (e.code === 'LIMITE_ABBONAMENTO' || e.code === 'NOT_LOGGED_IN') {      // inutile provare gli altri
          for (const resto of ALIAS_MODELLI.slice(ALIAS_MODELLI.indexOf(id))) out.push({ id: resto, nome: resto, verificato: false, disponibile: null, errore: e.code });
          break;
        }
        const nonDisponibile = e.code === 'MODEL_NOT_FOUND';
        out.push({ id, nome: id, verificato: nonDisponibile, disponibile: nonDisponibile ? false : null, errore: e.code, messaggio: String(e.message).slice(0, 200) });
      }
    }
    this.verificaModelli = out.map(m => Object.assign({ verificatoIl: new Date().toISOString() }, m));
    return this.verificaModelli;
  }

  async _versione(env) {
    try { const r = await this._esegui(['--version'], { timeoutMs: 15000, env }); return r.code === 0 ? r.out.trim().slice(0, 80) : null; } catch (e) { return null; }
  }

  async discoverCapabilities({ probe = false, signal } = {}) {
    const { env, rimosse } = ambientePulito(this.envBase);
    const salute = await this.healthCheck({ forza: true, signal });
    const modelli = await this.listAvailableModels({ probe, signal });
    return {
      id: this.id, strumento: 'Claude Code (claude -p)',
      eseguibile: this.exe, avvioSenzaShell: !this.usaShell, versione: await this._versione(env),
      autenticazione: Object.assign({ richiesta: 'login claude.ai dell\'abbonamento (nessuna chiave API)', ok: salute.ok, errore: salute.errore }, salute.dettagli || {}),
      variabiliApiRimosse: rimosse,
      modalitaNonInterattiva: true, formatoOutput: 'json', selezioneModello: true, modelli,
      supportaCancellazione: true, supportaTimeout: true,
      supportaStreaming: 'disponibile (stream-json), non usato: la risposta e trattenuta fino al Quality Gate',
      metriche: { token: 'riportati dal provider', costo: 'equivalente a listino API, non addebitato', limiti: 'visibili solo come errore al raggiungimento' },
      limitiUso: 'limiti dell\'abbonamento, non esposti in anticipo',
      compatibileRouting: true
    };
  }

  // Controlla che Claude Code sia collegato all'ABBONAMENTO e non a una chiave API o a un provider cloud.
  async healthCheck({ forza = false, signal } = {}) {
    if (this.sessione && !forza && Date.now() - this.sessioneTs < 60000) return this.sessione;
    const { env, rimosse } = ambientePulito(this.envBase);
    let r;
    try { r = await this._esegui(['auth', 'status'], { signal, timeoutMs: 20000, env }); }
    catch (e) { return this._memo({ ok: false, errore: e.message, dettagli: { rimosse } }); }
    let j = null;
    try { j = JSON.parse(r.out); } catch (e) { /* non JSON */ }
    if (!j) return this._memo({ ok: false, errore: 'Non riesco a leggere lo stato del login di Claude Code. Esegui "claude auth status" in un terminale.', dettagli: { rimosse } });
    const dettagli = { loggato: !!j.loggedIn, metodo: j.authMethod || null, provider: j.apiProvider || null, piano: j.subscriptionType || null, rimosse };
    if (!j.loggedIn) return this._memo({ ok: false, errore: 'Claude Code non e collegato a nessun account. Apri un terminale, esegui "claude" e fai il login con il tuo abbonamento.', dettagli });
    if (j.authMethod !== 'claude.ai' || (j.apiProvider && j.apiProvider !== 'firstParty')) {
      return this._memo({ ok: false, errore: 'Claude Code non usa il login dell\'abbonamento (metodo: ' + j.authMethod + ', provider: ' + j.apiProvider + '). Orbit non lavora per non rischiare fatturazione API: esegui /logout e /login con il tuo account claude.ai.', dettagli });
    }
    return this._memo({ ok: true, errore: null, dettagli });
  }
  verificaSessione(o) { return this.healthCheck(o); }                         // nome storico
  async listModels() { return this.listAvailableModels({ probe: false }); }   // nome storico usato dal registro modelli
  _memo(x) { this.sessione = x; this.sessioneTs = Date.now(); return x; }
}

module.exports = { ClaudeCodeProvider, ambientePulito, costruisciPrompt, classificaErrore, risolviEseguibile, ALIAS_MODELLI, SISTEMA_BREVE, quota };
