'use strict';
// ClaudePersistentProvider: stesso contratto e stessa autenticazione di ClaudeCodeProvider (login claude.ai, nessuna API a pagamento),
// ma i processi `claude` sono GIA AVVIATI quando arriva la richiesta: il costo di avvio (circa 1 s) e l'attesa del riepilogo che
// Claude Code produce dopo ogni turno (circa 2 s) escono dal percorso critico.
//
// ---- Protocollo (verificato sulla versione installata di Claude Code, vedi docs/PERFORMANCE.md) ----
// Ingresso   claude -p --input-format stream-json: una riga JSON {"type":"user","message":{"role":"user","content":"..."}} per turno
// Uscita     --output-format stream-json --verbose --include-partial-messages: una riga JSON per evento
// Turno      la RISPOSTA e completa al primo stream_event message_stop con stop_reason end_turn (message_delta porta i token finali).
//            L'evento `result` arriva circa 2 s dopo (riepilogo post turno) e chiude il turno dal punto di vista di Claude Code.
// Isolamento un worker serve UN turno alla volta e nessun contenuto di una richiesta puo arrivare a un'altra:
//            - riuso 1 (predefinito, "monouso"): dopo la risposta il processo viene terminato e ne parte subito uno nuovo e pulito;
//            - riuso N>1: dopo la risposta si attende `result`, si invia /clear (comandi slash attivi) e si riusa; dopo N turni il processo e sostituito.
// Fallback   nessun worker libero, avvio fallito, processo morto, protocollo non valido: UNA sola ripetizione col sistema tradizionale
//            (`claude -p`, processo nuovo). La chiamata e di sola lettura (strumenti spenti o solo WebSearch/WebFetch), quindi ripeterla non
//            produce effetti esterni. Timeout, annullamento, limiti d'abbonamento ed errori del modello NON si ripetono.
// Il processo non ha piu capacita del `claude -p` attuale: stessi argomenti (--tools "" oppure solo web, dontAsk, nessuna sessione salvata,
// cartella neutra fuori dal vault, nessun MCP) e stesso ambiente ripulito da chiavi API.
const { spawn, execFile, spawnSync } = require('child_process');
const { ClaudeCodeProvider, ambientePulito, costruisciPrompt, classificaErrore, SISTEMA_BREVE, quota } = require('./claude-code');
const { OrbitError, errori } = require('../errors');
const { performance } = require('node:perf_hooks');

// Guasti del processo persistente (caduto, protocollo non valido, non pronto): solo questi ammettono UNA ripetizione col sistema
// tradizionale. OrbitError scarta i campi che non conosce, quindi il marcatore si assegna qui, senza toccare errors.js.
// Timeout, annullamento, limiti dell'abbonamento e modello non valido NON hanno il marcatore: non si ripetono mai.
class ErrorePersistente extends OrbitError {
  constructor(code, message, extra) { super(code, message, extra); this.persistente = true; }
}

const IS_WIN = process.platform === 'win32';
const MAX_OUTPUT_PROCESSO = 16384;      // tetto di token del processo: come nel sistema tradizionale e largo, la brevita si chiede nel prompt
const STOP_VALIDI = new Set(['end_turn', 'max_tokens', 'stop_sequence']);

function uccidiTree(pid) {
  if (!pid) return;
  try { if (IS_WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); else process.kill(pid, 'SIGKILL'); } catch (e) { /* gia terminato */ }
}
function uccidiTreeSync(pid) {
  if (!pid) return;
  try { if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); else process.kill(pid, 'SIGKILL'); } catch (e) { /* gia terminato */ }
}

// ---- Chiusura dei processi all'uscita di Orbit: un solo insieme di gestori per tutti i provider persistenti ----
const provider = new Set();
let gestoriInstallati = null;
function installaGestori() {
  if (gestoriInstallati) return;
  const chiudiTutti = () => { for (const p of provider) p._chiudiSync(); };
  const exit = () => chiudiTutti();
  const segnali = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => {
    const h = () => { chiudiTutti(); if (process.listenerCount(s) <= 1) process.exit(s === 'SIGINT' ? 130 : 143); };
    return [s, h];
  });
  process.on('exit', exit);
  for (const [s, h] of segnali) process.on(s, h);
  gestoriInstallati = { exit, segnali };
}
function rimuoviGestori() {
  if (!gestoriInstallati || provider.size) return;
  process.removeListener('exit', gestoriInstallati.exit);
  for (const [s, h] of gestoriInstallati.segnali) process.removeListener(s, h);
  gestoriInstallati = null;
}

class Worker {
  constructor(prov, chiave, { model, web }) {
    this.prov = prov; this.chiave = chiave; this.model = model; this.web = web;
    this.stato = 'pronto';           // pronto (anche se ancora in avvio: il processo accetta subito il messaggio) -> occupato -> pulizia -> pronto | morto
    this.fase = null;                // null | turno | attesaResult | clear
    this.turni = 0; this.ultimoUso = Date.now(); this.pid = null; this.creato = Date.now(); this.spawnMs = null;
    this.turno = null; this.buf = ''; this.slash = prov.riuso > 1; this.guasto = false;
    this._avvia();
  }

  _args() {
    const strumenti = this.web ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
    const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', this.model]
      .concat(strumenti, ['--permission-mode', 'dontAsk', '--setting-sources', 'user']);
    if (!this.slash) base.push('--disable-slash-commands');
    return base.concat(['--no-session-persistence', '--strict-mcp-config', '--system-prompt', SISTEMA_BREVE]);
  }

  _avvia() {
    const p = this.prov;
    const { env } = ambientePulito(p.envBase);
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(MAX_OUTPUT_PROCESSO);
    p._preparaCwd();
    const tutti = p.binArgs.concat(this._args());
    let child;
    try {
      child = p.usaShell
        ? spawn([quota(p.exe)].concat(tutti.map(quota)).join(' '), { shell: true, cwd: p.cwd, env, windowsHide: true })
        : spawn(p.exe, tutti, { cwd: p.cwd, env, windowsHide: true });
    } catch (e) { this.stato = 'morto'; this.guasto = true; return; }
    this.child = child; this.pid = child.pid;
    child.once('spawn', () => { this.spawnMs = Date.now() - this.creato; });          // il processo esiste e accetta messaggi (misura di disponibilita)
    child.stdout.on('data', d => this._dati(d));
    child.stderr.on('data', () => { /* diagnostica non conservata */ });
    child.on('error', e => { this.guasto = true; this._muori('avvio', null, e); });
    child.on('close', code => this._muori('chiuso', code));
    child.stdin.on('error', () => { /* il processo puo chiudersi prima di leggere */ });
  }

  get libero() { return this.stato === 'pronto'; }

  _dati(d) {
    if (this.stato === 'morto') return;                // il processo e gia stato scartato: quello che dice dopo non conta (niente conteggi doppi)
    this.buf += d.toString('utf8');
    if (this.buf.length > 4 * 1024 * 1024) return this._protocolloNonValido('output eccessivo');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const riga = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!riga) continue;
      let e; try { e = JSON.parse(riga); } catch (err) { return this._protocolloNonValido('riga non JSON'); }
      this._evento(e);
      if (this.stato === 'morto') return;
    }
  }

  _evento(e) {
    if (e.type === 'result') return this._result(e);
    const t = this.turno;
    if (!t || this.fase !== 'turno' || e.type !== 'stream_event' || !e.event) return;
    const ev = e.event;
    if (ev.type === 'message_start') {
      t.messaggi++; if (t.messaggi > 1) return this._protocolloNonValido('piu messaggi nello stesso turno');
      t.tPrimo = performance.now() - t.t0; t.modello = ev.message && ev.message.model;
      t.marca('primo_output');
    } else if (ev.type === 'content_block_start') t.blocchi[ev.index] = ev.content_block && ev.content_block.type;
    else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && t.blocchi[ev.index] === 'text') {
      if (!t.testo && ev.delta.text) t.marca('primo_testo');
      t.testo += ev.delta.text || '';
    }
    else if (ev.type === 'message_delta') { t.stop = ev.delta && ev.delta.stop_reason; if (ev.usage) t.usage = ev.usage; }
    else if (ev.type === 'message_stop') {
      if (!STOP_VALIDI.has(t.stop)) return this._protocolloNonValido('fine messaggio con stop_reason ' + t.stop);
      t.tFine = performance.now() - t.t0;
      this.fase = 'attesaResult';
      this.turno = null;
      t.fine(t.resolve, t);
    }
  }

  _result(e) {
    if (this.fase === 'turno') {                       // result prima della fine del messaggio: errore di Claude Code o protocollo anomalo
      const t = this.turno;
      if (e.is_error) { const err = classificaErrore(e.result || e.subtype, 1); this._butta(); if (t) t.fine(t.reject, err); return; }
      return this._protocolloNonValido('result senza fine messaggio');
    }
    if (this.fase === 'attesaResult') {
      this.prov.stat.turniExtra += Math.max(0, (e.num_turns || 1) - 1);
      if (this.stato !== 'pulizia') return;           // monouso: il processo e gia stato chiuso
      if (e.is_error) return this._butta();
      this.fase = 'clear';
      try { this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '/clear' } }) + '\n'); } catch (err) { this._butta(); }
      return;
    }
    if (this.fase === 'clear') {
      if (e.is_error || (e.num_turns || 0) !== 0) return this._butta();   // /clear non e un turno del modello: se lo fosse, il processo non e piu affidabile
      this.fase = null; this.stato = 'pronto'; this.ultimoUso = Date.now();
    }
  }

  // Invia un turno. La promise si risolve alla FINE DEL MESSAGGIO con l'oggetto turno.
  invia(prompt, { signal, timeoutMs, onPerformance }) {
    return new Promise((resolve, reject) => {
      if (this.stato !== 'pronto') return reject(new ErrorePersistente('PERSISTENTE_NON_PRONTO', 'Il processo persistente non e pronto.', { persistente: true }));
      this.stato = 'occupato'; this.fase = 'turno'; this.turni++; this.ultimoUso = Date.now();
      const t = this.turno = { resolve, reject, testo: '', blocchi: {}, usage: null, stop: null, modello: null, messaggi: 0, t0: performance.now(), tPrimo: null, tFine: null, chiuso: false };
      t.marca = fase => { try { onPerformance?.(fase); } catch (e) { /* tracing non blocca il provider */ } };
      t.fine = (fn, v) => { if (t.chiuso) return; t.chiuso = true; clearTimeout(t.timer); if (signal) signal.removeEventListener('abort', t.onAbort); fn(v); };
      t.onAbort = () => { this._butta(); t.fine(reject, errori.aborted()); };
      if (timeoutMs) t.timer = setTimeout(() => { this.prov.stat.timeout++; this._butta(); t.fine(reject, errori.timeout()); }, timeoutMs);
      if (signal) { if (signal.aborted) return t.onAbort(); signal.addEventListener('abort', t.onAbort, { once: true }); }
      try { this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'); }
      catch (e) { this.guasto = true; this._butta(); t.fine(reject, new ErrorePersistente('PERSISTENTE_CADUTO', 'Il processo persistente non risponde.', { persistente: true })); }
    });
  }

  _protocolloNonValido(motivo) {
    const t = this.turno; this.guasto = true; this.prov.stat.protocollo++; this.prov.ultimoMotivoProtocollo = motivo;     // diagnostica: perche il protocollo e stato giudicato non valido
    this._butta();
    if (t) t.fine(t.reject, new ErrorePersistente('PERSISTENTE_PROTOCOLLO', 'Protocollo del processo persistente non valido: ' + motivo + '.', { persistente: true }));
  }

  // Dopo la risposta consegnata: monouso = termina subito; riuso = resta in "pulizia" fino a result + /clear.
  rilascia() {
    if (this.stato === 'morto') return;
    if (this.prov.riuso <= 1 || this.turni >= this.prov.riuso) return this._butta();
    this.stato = 'pulizia';
  }

  // Un processo si termina solo se e ancora il figlio VIVO di Orbit: se e gia uscito il suo PID potrebbe essere stato riusato da un altro programma.
  get figlioVivo() { return !!(this.child && this.pid && this.child.exitCode === null && this.child.signalCode === null); }

  _butta() {
    if (this.stato === 'morto') return;
    this.stato = 'morto'; clearTimeout(this.timerTtl);
    if (this.figlioVivo) this.prov._uccidiPid(this.pid);
    this.prov._workerMorto(this);
  }

  _muori(perche, code, errore) {
    const eraMorto = this.stato === 'morto';
    this.stato = 'morto'; clearTimeout(this.timerTtl);
    if (!eraMorto) this.guasto = true;                 // il processo e morto da solo (non scartato da Orbit): conta come guasto, quindi niente riavvii a catena
    const t = this.turno;
    if (t && !t.chiuso) {
      this.prov.stat.caduti++; this.guasto = true;
      t.fine(t.reject, new ErrorePersistente('PERSISTENTE_CADUTO', 'Il processo persistente si e chiuso prima della risposta' + (code != null ? ' (codice ' + code + ')' : '') + (errore ? ': ' + errore.message : '') + '.', { persistente: true }));
    }
    if (!eraMorto) this.prov._workerMorto(this);
  }
}

class ClaudePersistentProvider extends ClaudeCodeProvider {
  // Opzioni specifiche (tutte con valori sicuri): riuso (turni per processo, 1 = monouso), poolMax (processi per modello),
  // ttlInattivoMs (un processo fermo piu a lungo viene chiuso e non rimpiazzato), prewarm (chiavi tenute pronte, es. ['haiku'], ['sonnet:web']),
  // guastiMax e pausaGuastiMs (interruttore: dopo N guasti di fila la modalita persistente si sospende e si usa solo il sistema tradizionale).
  constructor(opts = {}) {
    const { webPersistente = false, riuso = 1, poolMax = 2, ttlInattivoMs = 10 * 60 * 1000, prewarm = ['haiku'], guastiMax = 3, pausaGuastiMs = 5 * 60 * 1000, ...base } = opts;
    super(base);
    this.webPersistente = !!webPersistente;     // le richieste con ricerca web restano sul sistema tradizionale finche non sono validate (vedi docs/PERFORMANCE.md)
    this.riuso = Math.max(1, Math.min(100, riuso | 0 || 1)); this.poolMax = Math.max(1, Math.min(4, poolMax | 0 || 1));
    this.ttlInattivoMs = ttlInattivoMs; this.prewarm = prewarm; this.guastiMax = guastiMax; this.pausaGuastiMs = pausaGuastiMs;
    this.workers = new Map();                    // chiave -> Worker[]
    this.guastiDiFila = 0; this.sospesoFino = 0; this.chiuso = false;
    this.stat = { persistente: 0, tradizionale: 0, fallback: 0, nessunWorker: 0, caduti: 0, protocollo: 0, timeout: 0, turniExtra: 0, avviati: 0 };
    this.ultimiTempi = [];
    provider.add(this); installaGestori();
  }

  static chiave(model, web) { return model + (web ? ':web' : ''); }

  // Avvia i processi da tenere pronti, ma solo dopo aver verificato il login dell'abbonamento.
  async riscalda(chiavi = this.prewarm) {
    if (this.chiuso || this._sospeso()) return false;
    const s = await this.healthCheck();
    if (!s.ok) return false;
    for (const c of chiavi) { const [model, web] = c.split(':'); if (web === 'web' && !this.webPersistente) continue; this._assicura(model, web === 'web'); }
    return true;
  }

  // Dopo ogni controllo del login riuscito (lo fanno l'interfaccia e l'orchestratore prima delle richieste) si tiene pronto un processo per modello
  // del pre-riscaldamento: all'avvio, e di nuovo dopo un'inattivita lunga. Mai piu di uno per chiave e mai prima di aver verificato l'abbonamento.
  async healthCheck(o) {
    const r = await super.healthCheck(o);
    if (r && r.ok && !this.chiuso) this._riscaldaSeServe();
    return r;
  }

  _riscaldaSeServe() {
    for (const c of this.prewarm) { const [model, web] = c.split(':'); if (web === 'web' && !this.webPersistente) continue; this._assicura(model, web === 'web', { soloSeNessunoLibero: true }); }
  }

  _sospeso() { return Date.now() < this.sospesoFino; }

  // Ganci di terminazione (sostituibili nei test): terminano il processo e i suoi figli, mai altri processi.
  _uccidiPid(pid) { uccidiTree(pid); }
  _uccidiPidSync(pid) { uccidiTreeSync(pid); }

  // Avvio di Orbit: controlla il login dell'abbonamento e, se valido, prepara il pool (healthCheck lo fa). Non aspetta il browser.
  avvia() { this.avvioRichiesto = true; return this.healthCheck().catch(() => ({ ok: false })); }

  // soloSeNessunoLibero: crea un processo solo se per quella chiave non ce n'e gia uno libero (evita processi doppi e RAM sprecata).
  _assicura(model, web, { soloSeNessunoLibero = false } = {}) {
    if (this.chiuso || this._sospeso()) return null;
    const chiave = ClaudePersistentProvider.chiave(model, web);
    const lista = (this.workers.get(chiave) || []).filter(w => w.stato !== 'morto');
    this.workers.set(chiave, lista);
    if (lista.length >= this.poolMax) return null;
    if (soloSeNessunoLibero && lista.some(w => w.libero)) return null;
    const w = new Worker(this, chiave, { model, web }); this.stat.avviati++;
    if (w.stato === 'morto') { this._guasto(); return null; }
    lista.push(w); this._programmaTtl(w);
    return w;
  }

  _programmaTtl(w) {
    clearTimeout(w.timerTtl);
    w.timerTtl = setTimeout(() => {
      if (w.stato === 'pronto' && Date.now() - w.ultimoUso >= this.ttlInattivoMs) { w.inattivo = true; w._butta(); }   // inattivo: chiuso e non rimpiazzato
      else if (w.stato !== 'morto') this._programmaTtl(w);
    }, this.ttlInattivoMs);
    if (w.timerTtl.unref) w.timerTtl.unref();
  }

  _workerMorto(w) {
    clearTimeout(w.timerTtl);
    const lista = this.workers.get(w.chiave) || []; const i = lista.indexOf(w); if (i >= 0) lista.splice(i, 1);
    if (w.guasto) { this._guasto(); return; }
    // sostituzione immediata (niente timer: un timer puo ritardare la creazione se il ciclo eventi e occupato), solo se serve e se Orbit non sta chiudendo
    if (!this.chiuso && !this._sospeso() && !w.inattivo) this._assicura(w.model, w.web, { soloSeNessunoLibero: true });
  }

  _guasto() {
    this.guastiDiFila++;
    if (this.guastiDiFila >= this.guastiMax) { this.sospesoFino = Date.now() + this.pausaGuastiMs; this.guastiDiFila = 0; }
  }

  _libero(chiave) { return (this.workers.get(chiave) || []).find(w => w.libero) || null; }

  async executeTask(req) {
    const { model, strumentiWeb = false } = req;
    if (!model || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(model)) return super.executeTask(req);     // stessa validazione e stesso errore del sistema tradizionale
    if (this.chiuso || this._sospeso()) return this._tradizionale(req, this.chiuso ? 'chiuso' : 'sospeso');
    if (strumentiWeb && !this.webPersistente) return this._tradizionale(req, 'web-non-validato');
    const w = this._libero(ClaudePersistentProvider.chiave(model, strumentiWeb));
    if (!w) { this.stat.nessunWorker++; this._assicura(model, strumentiWeb); return this._tradizionale(req, 'nessun-worker-libero'); }
    try { return await this._conWorker(w, req); }
    catch (e) {
      if (e && e.persistente) return this._tradizionale(req, e.code || 'persistente-fallito', true);
      throw e;
    }
  }

  async _tradizionale(req, motivo, fallback = false) {
    if (fallback) this.stat.fallback++; else this.stat.tradizionale++;
    const r = await super.executeTask(req);
    r.modalita = fallback ? 'tradizionale-fallback' : 'tradizionale'; r.motivoModalita = motivo;
    return r;
  }

  async _conWorker(w, { executionId, model, system, messages, maxTokens, signal, timeoutMs, onPerformance }) {
    const id = executionId || ('exec_p_' + Date.now().toString(36) + '_' + (++this._n || (this._n = 1)));
    if (this.attive.has(id)) throw new OrbitError('DUPLICATA', 'Esiste gia un\'esecuzione con lo stesso identificativo: non avvio processi duplicati.', { fatal: true });
    // un testo che comincia con "/" sarebbe eseguito come comando slash quando questi sono attivi: non deve mai succedere
    let prompt = costruisciPrompt({ system, messages, maxTokens });
    if (/^\s*\//.test(prompt)) prompt = 'Testo: ' + prompt;
    this.attive.set(id, { termina: () => { const t = w.turno; if (t && t.onAbort) t.onAbort(); }, pid: w.pid });
    const t0 = performance.now();
    let t;
    const etaProcessoMs = Date.now() - w.creato;
    try { onPerformance?.('processo_scelto'); } catch (e) { /* tracing non blocca il provider */ }
    const inviata = w.invia(prompt, { signal, timeoutMs, onPerformance });
    // sostituzione ANTICIPATA: il processo di riserva parte appena questo prende il turno, cosi e gia pronto quando la risposta arriva
    // e la chiamata successiva (per esempio il verificatore dello stesso modello) lo trova subito
    if (this.riuso <= 1) this._assicura(model, w.web, { soloSeNessunoLibero: true });      // in riuso il processo torna libero da solo: nessuna riserva
    try { t = await inviata; }
    finally { this.attive.delete(id); }
    const u = t.usage || {};
    const entrata = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const turniWorker = w.turni;
    w.rilascia(); this.stat.persistente++; this.guastiDiFila = 0;
    this.ultimiTempi.push({ modello: model, primoOutputMs: t.tPrimo, rispostaMs: t.tFine, etaProcessoMs, spawnMs: w.spawnMs }); if (this.ultimiTempi.length > 200) this.ultimiTempi.shift();
    return {
      text: t.testo,
      usage: { inputTokens: Number.isFinite(u.input_tokens) ? entrata : null, outputTokens: Number.isFinite(u.output_tokens) ? u.output_tokens : null },
      stopReason: t.stop === 'max_tokens' ? 'max_tokens' : (t.stop || null),
      model: t.modello || model, latencyMs: performance.now() - t0, costoEquivalente: null, provider: this.id, executionId: id,
      modelRequested: model, modelReported: t.modello || null, modelsReported: t.modello ? [t.modello] : [],
      processo: { codiceUscita: 0, durataMs: performance.now() - t0, pid: w.pid },
      modalita: 'persistente', tempi: { primoOutputMs: t.tPrimo, rispostaMs: t.tFine, turnoDelProcesso: turniWorker, etaProcessoMs, spawnMs: w.spawnMs }
    };
  }

  stato() {
    const w = []; for (const l of this.workers.values()) for (const x of l) w.push({ chiave: x.chiave, stato: x.stato, pid: x.pid, turni: x.turni });
    return { modalita: 'persistente', ultimiTempi: this.ultimiTempi.slice(-20), riuso: this.riuso, poolMax: this.poolMax, sospesoFino: this.sospesoFino || null, workers: w, statistiche: Object.assign({}, this.stat) };
  }

  _chiudiSync() {
    this.chiuso = true;
    for (const l of this.workers.values()) for (const w of l) { clearTimeout(w.timerTtl); const vivo = w.figlioVivo; w.stato = 'morto'; if (vivo) this._uccidiPidSync(w.pid); }
    this.workers.clear();
  }

  // Chiusura ordinata (arresto di Orbit, test): termina tutti i processi e ritira i gestori di uscita.
  chiudi() { this._chiudiSync(); provider.delete(this); rimuoviGestori(); }
}

module.exports = { ClaudePersistentProvider, Worker };
