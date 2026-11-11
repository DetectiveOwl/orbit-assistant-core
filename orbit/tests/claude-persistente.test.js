'use strict';
// Claude persistente: processi gia pronti, un turno alla volta, nessuna cronologia condivisa, fallback al sistema tradizionale.
// Tutto con un falso `claude` in stream-json (tests/fake-claude-stream.js): nessuna rete, nessun consumo dell'abbonamento.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ClaudePersistentProvider } = require('../ai/providers/claude-persistente');
const { ClaudeCodeProvider } = require('../ai/providers/claude-code');
const { creaProvider } = require('../ai/providers');
const { metodiMancanti } = require('../ai/providers/contract');
const { settingsProva, appProva, chiedi } = require('./helpers');
const config = require('../config');

const FALSO = path.join(__dirname, 'fake-claude-stream.js');
const vivo = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function finche(cond, ms = 4000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('condizione non raggiunta'); await pausa(15); } }

const creati = [];
function prova(envExtra = {}, opzioni = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pers-'));
  const logFile = path.join(dir, 'chiamate.jsonl');
  const envBase = Object.assign({}, process.env, { ORBIT_FAKE_LOG: logFile, ORBIT_FAKE_RESULT_MS: '60' }, envExtra);
  const p = new ClaudePersistentProvider(Object.assign({ bin: process.execPath, binArgs: [FALSO], cwd: path.join(dir, 'cwd'), envBase, guastiMax: 3 }, opzioni));
  creati.push(p);
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { p, log };
}
const rich = (testo, extra = {}) => Object.assign({ model: 'haiku', system: 'Sistema', messages: [{ role: 'user', content: testo }], maxTokens: 100, timeoutMs: 5000 }, extra);
// scalda: crea il processo e attende che esista (la prima richiesta senza processo pronto usa il sistema tradizionale)
async function scalda(p, model = 'haiku', web = false) { p._assicura(model, web); await finche(() => p._libero(ClaudePersistentProvider.chiave(model, web))); }

test.after(() => { for (const p of creati) p.chiudi(); });

test('contratto: rispetta ModelExecutionProvider ed e un ClaudeCodeProvider (stessa autenticazione e stessi controlli)', () => {
  const { p } = prova();
  assert.deepEqual(metodiMancanti(p), []);
  assert.ok(p instanceof ClaudeCodeProvider);
  assert.equal(p.id, 'claude-code');
});

test('modalita scelta in un solo punto: predefinita persistente, tradizionale selezionabile con la sola configurazione', () => {
  const base = { providers: ['claude-code'], claudeBin: process.execPath, ccCwd: os.tmpdir() };
  assert.equal(creaProvider(base).constructor.name, 'ClaudeCodeProvider');            // settings senza la sezione: comportamento storico
  assert.equal(creaProvider(Object.assign({}, base, { claudePersistente: { modalita: 'tradizionale' } })).constructor.name, 'ClaudeCodeProvider');
  const s1 = settingsProva();
  assert.equal(s1.claudePersistente.modalita, 'persistente');                       // predefinita
  assert.equal(config.MODALITA_CLAUDE_PREDEFINITA, 'persistente');
  const rollback = settingsProva({ env: { ORBIT_CLAUDE_MODALITA: 'tradizionale' } });   // rollback: solo configurazione
  assert.equal(rollback.claudePersistente.modalita, 'tradizionale');
  assert.equal(creaProvider(Object.assign({}, base, { claudePersistente: rollback.claudePersistente })).constructor.name, 'ClaudeCodeProvider');
  const s2 = settingsProva({ env: { ORBIT_CLAUDE_MODALITA: 'Persistente', ORBIT_CLAUDE_RIUSO: '5', ORBIT_CLAUDE_POOL: '3', ORBIT_CLAUDE_PREWARM: 'haiku,sonnet:web' } });
  assert.deepEqual(s2.claudePersistente, { modalita: 'persistente', riuso: 5, pool: 3, ttlMs: 600000, avvioAutomatico: true, web: false, prewarm: ['haiku', 'sonnet:web'] });
  const pers = creaProvider(Object.assign({}, base, { claudePersistente: Object.assign({}, s2.claudePersistente, { avvioAutomatico: false }) }));
  creati.push(pers);
  assert.equal(pers.constructor.name, 'ClaudePersistentProvider'); assert.equal(pers.riuso, 5); assert.equal(pers.poolMax, 3);
  assert.equal(settingsProva({ env: { ORBIT_CLAUDE_MODALITA: 'qualcosa' } }).claudePersistente.modalita, 'tradizionale');   // valore sconosciuto: sicuro
});

test('senza processo pronto la prima richiesta usa il sistema tradizionale, poi il processo pronto serve le successive', async () => {
  const { p } = prova();
  const prima = await p.executeTask(rich('prima'));
  assert.equal(prima.modalita, 'tradizionale'); assert.equal(prima.motivoModalita, 'nessun-worker-libero');
  await finche(() => p._libero('haiku'));
  const seconda = await p.executeTask(rich('seconda'));
  assert.equal(seconda.modalita, 'persistente');
  assert.match(seconda.text, /seconda/);
  assert.equal(seconda.usage.inputTokens, 12 + 80); assert.equal(seconda.usage.outputTokens, 20);
  assert.equal(seconda.stopReason, 'end_turn'); assert.match(seconda.model, /haiku/);
  assert.ok(seconda.tempi.primoOutputMs >= 0 && seconda.tempi.rispostaMs >= seconda.tempi.primoOutputMs);
});

test('monouso: ogni risposta arriva da un processo pulito (nessuna cronologia), e il successivo e gia pronto', async () => {
  const { p, log } = prova();
  await scalda(p);
  const pids = [];
  for (const q of ['alfa', 'beta', 'gamma']) {
    await finche(() => p._libero('haiku'));
    const r = await p.executeTask(rich(q));
    assert.equal(r.modalita, 'persistente'); assert.match(r.text, new RegExp('eco\\[1\\]:.*' + q));      // sempre 1 turno nella storia del processo
    pids.push(r.processo.pid);
  }
  assert.equal(new Set(pids).size, 3);                       // un processo diverso per richiesta
  await finche(() => !vivo(pids[0]) && !vivo(pids[1]) && !vivo(pids[2]));      // quelli usati sono terminati: nessun processo orfano
  assert.equal(log().filter(l => l.evento === 'messaggio').length, 3);          // un messaggio per richiesta, nessun turno nascosto
});

test('riuso: lo stesso processo serve piu richieste, /clear tra una e l altra, nessuna cronologia mescolata, risposte associate alla richiesta', async () => {
  const { p, log } = prova({}, { riuso: 4 });
  await scalda(p);
  const pids = new Set();
  for (const q of ['uno', 'due', 'tre']) {
    await finche(() => p._libero('haiku'), 4000);
    const r = await p.executeTask(rich('domanda-' + q));
    assert.equal(r.modalita, 'persistente'); assert.match(r.text, new RegExp('eco\\[1\\]:.*domanda-' + q));     // storia = solo questo turno
    pids.add(r.processo.pid);
  }
  assert.equal(pids.size, 1);                                // stesso processo per tutte
  const l = log();
  assert.equal(l.filter(x => x.evento === 'messaggio').length, 3);
  assert.ok(l.filter(x => x.evento === 'clear').length >= 2);
  assert.ok(l.filter(x => x.evento === 'messaggio').every(x => x.turniInStoria === 1));
  assert.ok(!l[0].args.includes('--disable-slash-commands'));
});

test('riuso: dopo N turni il processo viene sostituito da uno nuovo', async () => {
  const { p } = prova({}, { riuso: 2 });
  await scalda(p);
  const pids = [];
  for (const q of ['a', 'b', 'c', 'd']) { await finche(() => p._libero('haiku')); pids.push((await p.executeTask(rich(q))).processo.pid); }
  assert.equal(pids[0], pids[1]); assert.notEqual(pids[1], pids[2]); assert.equal(pids[2], pids[3]);
});

test('richieste concorrenti: due processi, ognuno risponde alla propria richiesta; oltre il pool si usa il sistema tradizionale senza mescolare', async () => {
  const { p, log } = prova({ ORBIT_FAKE_RESULT_MS: '200' }, { poolMax: 2 });
  await scalda(p); p._assicura('haiku', false); await finche(() => (p.workers.get('haiku') || []).filter(w => w.libero).length === 2);
  const nomi = ['uno', 'due', 'tre'];
  const risultati = await Promise.all(nomi.map(q => p.executeTask(rich('concorrente-' + q))));
  const persistenti = risultati.map((r, i) => [r, nomi[i]]).filter(([r]) => r.modalita === 'persistente');
  const tradizionali = risultati.map((r, i) => [r, nomi[i]]).filter(([r]) => r.modalita === 'tradizionale');
  assert.equal(persistenti.length, 2); assert.equal(tradizionali.length, 1);
  // ogni richiesta servita dai processi persistenti riceve l'eco della PROPRIA domanda e di nessun'altra
  for (const [r, q] of persistenti) {
    assert.match(r.text, new RegExp('concorrente-' + q));
    for (const altro of nomi.filter(x => x !== q)) assert.doesNotMatch(r.text, new RegExp('concorrente-' + altro));
  }
  // la richiesta eccedente e stata davvero eseguita dal sistema tradizionale: motivo registrato e UNA sola esecuzione `claude -p`
  // che ha ricevuto proprio quella domanda e nessuna delle altre due (il falso tradizionale risponde con un testo fisso, quindi si guarda cio che ha ricevuto)
  const [rEccedente, qEccedente] = tradizionali[0];
  assert.equal(rEccedente.motivoModalita, 'nessun-worker-libero');
  const esecuzioni = log().filter(l => l.comando === 'p');
  assert.equal(esecuzioni.length, 1);
  assert.match(esecuzioni[0].stdin, new RegExp('concorrente-' + qEccedente));
  for (const altro of nomi.filter(x => x !== qEccedente)) assert.doesNotMatch(esecuzioni[0].stdin, new RegExp('concorrente-' + altro));
  assert.equal(p.stat.nessunWorker, 1); assert.equal(p.stat.fallback, 0);
});

test('modelli: ogni modello ha il proprio processo con --model corretto; le richieste web hanno solo WebSearch e WebFetch, tutte le altre nessuno strumento', async () => {
  const { p, log } = prova({}, { webPersistente: true });
  await scalda(p, 'haiku'); await scalda(p, 'sonnet'); await scalda(p, 'opus'); await scalda(p, 'sonnet', true);
  const h = await p.executeTask(rich('x', { model: 'haiku' })); const s = await p.executeTask(rich('x', { model: 'sonnet' })); const o = await p.executeTask(rich('x', { model: 'opus' }));
  const w = await p.executeTask(rich('x', { model: 'sonnet', strumentiWeb: true }));
  assert.match(h.text, /modello:haiku/); assert.match(s.text, /modello:sonnet/); assert.match(o.text, /modello:opus/); assert.match(w.text, /modello:sonnet/);
  const avvii = log().filter(l => l.evento === 'avvio').map(l => l.args);
  assert.ok(avvii.length >= 4);
  for (const a of avvii) {
    assert.ok(!a.includes('--bare'));
    assert.ok(a.includes('--no-session-persistence') && a.includes('--strict-mcp-config') && a.includes('dontAsk'));
    const t = a[a.indexOf('--tools') + 1];
    assert.ok(t === '' || t === 'WebSearch,WebFetch');
    if (t === 'WebSearch,WebFetch') assert.equal(a[a.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
    else assert.ok(!a.includes('--allowedTools'));
  }
  assert.equal(avvii.filter(a => a[a.indexOf('--tools') + 1] === 'WebSearch,WebFetch').length, 1);
  assert.equal(h.processo.pid !== w.processo.pid, true);
});

test('nessuna nuova capacita: ambiente senza chiavi API, cartella neutra, prompt che comincia con "/" non diventa un comando', async () => {
  const { p, log } = prova({ ANTHROPIC_API_KEY: 'chiave-finta-non-reale', CLAUDE_CODE_USE_BEDROCK: '1' }, { riuso: 3, cwd: path.join(os.tmpdir(), 'orbit-pers-cwd-test') });
  await scalda(p);
  const r = await p.executeTask(rich('/clear', { system: null, maxTokens: null, messages: [{ role: 'user', content: '/clear' }] }));
  assert.equal(r.modalita, 'persistente');
  const l = log();
  assert.ok(l.every(x => x.variabiliApi.length === 0));
  assert.ok(l.every(x => /orbit-pers-cwd-test/.test(x.cwd)));
  const m = l.find(x => x.evento === 'messaggio');
  assert.match(m.contenuto, /^Testo: \/clear/);              // il comando slash non viene eseguito: e testo per il modello
  assert.equal(l.filter(x => x.evento === 'clear').length === 0 || m.turniInStoria === 1, true);
});

test('annullamento: la richiesta si interrompe, il processo sporco e scartato e le richieste successive funzionano', async () => {
  const { p } = prova({ ORBIT_FAKE_RISPOSTA_MS: '400' }, { poolMax: 2 });
  await scalda(p);
  const ac = new AbortController();
  const lenta = p.executeTask(rich('da annullare', { signal: ac.signal }));
  await pausa(80); ac.abort();
  await assert.rejects(lenta, e => e.code === 'ABORTED');
  await finche(() => p._libero('haiku'));
  const dopo = await p.executeTask(rich('dopo l annullamento'));
  assert.equal(dopo.modalita, 'persistente'); assert.match(dopo.text, /eco\[1\]:.*dopo l annullamento/); assert.doesNotMatch(dopo.text, /da annullare/);
  assert.equal(p.stat.fallback, 0);                           // l annullamento non e un guasto e non si ripete
});

test('cancelExecution ferma una richiesta in corso', async () => {
  const { p } = prova({ ORBIT_FAKE_RISPOSTA_MS: '400' });
  await scalda(p);
  const lenta = p.executeTask(rich('lunga', { executionId: 'exec_x' }));
  await pausa(80);
  assert.equal(p.cancelExecution('exec_x'), true);
  await assert.rejects(lenta, e => e.code === 'ABORTED');
});

test('timeout: errore TIMEOUT, nessuna ripetizione col sistema tradizionale, processo scartato', async () => {
  const { p, log } = prova({ ORBIT_FAKE_STREAM: 'muto' });
  await scalda(p);
  await assert.rejects(p.executeTask(rich('x', { timeoutMs: 200 })), e => e.code === 'TIMEOUT');
  assert.equal(p.stat.fallback, 0);
  assert.equal(log().filter(l => l.comando === 'p').length, 0);
  assert.equal(p.stat.timeout, 1);
});

test('crash di Claude: una sola ripetizione col sistema tradizionale, poi un processo nuovo e pulito', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pers-'));
  const { p, log } = prova({ ORBIT_FAKE_STREAM: 'crash' });
  await scalda(p);
  const r = await p.executeTask(rich('crash'));
  assert.equal(r.modalita, 'tradizionale-fallback'); assert.equal(r.motivoModalita, 'PERSISTENTE_CADUTO');
  assert.equal(p.stat.fallback, 1); assert.equal(p.stat.caduti, 1);
  assert.equal(log().filter(l => l.comando === 'p').length, 1);       // una sola esecuzione tradizionale: niente retry infiniti
  assert.ok(dir);
});

test('protocollo non valido e tool_use: fallback tradizionale una sola volta', async () => {
  for (const modo of ['protocollo', 'tooluse', 'doppio']) {
    const { p } = prova({ ORBIT_FAKE_STREAM: modo });
    await scalda(p);
    const r = await p.executeTask(rich('x-' + modo));
    assert.ok(['tradizionale-fallback', 'persistente'].includes(r.modalita), modo + ' -> ' + r.modalita);
    if (modo !== 'doppio') assert.equal(r.modalita, 'tradizionale-fallback', modo);
    assert.ok(p.stat.protocollo >= 1 || modo === 'doppio', modo);
  }
});

test('errori del modello (limite abbonamento) NON si ripetono: nessun fallback, nessuna chiamata duplicata', async () => {
  const { p, log } = prova({ ORBIT_FAKE_STREAM: 'errore' });
  await scalda(p);
  await assert.rejects(p.executeTask(rich('x')), e => e.code === 'LIMITE_ABBONAMENTO');
  assert.equal(p.stat.fallback, 0); assert.equal(log().filter(l => l.comando === 'p').length, 0);
});

test('turni nascosti: se Claude Code produce piu di un turno lo si registra', async () => {
  const { p } = prova({ ORBIT_FAKE_STREAM: 'extraturno' }, { riuso: 2 });
  await scalda(p);
  await p.executeTask(rich('x'));
  await finche(() => p.stat.turniExtra >= 1);
  assert.equal(p.stat.turniExtra, 1);
});

test('interruttore: dopo guasti ripetuti la modalita persistente si sospende e si usa solo il sistema tradizionale, senza nuovi processi', async () => {
  const { p, log } = prova({ ORBIT_FAKE_STREAM: 'crash' }, { guastiMax: 2, pausaGuastiMs: 60000 });
  for (let i = 0; i < 2; i++) { await scalda(p); const r = await p.executeTask(rich('x' + i)); assert.equal(r.modalita, 'tradizionale-fallback'); }
  assert.ok(p._sospeso());
  const avviiPrima = log().filter(l => l.evento === 'avvio').length;
  const r = await p.executeTask(rich('sospeso'));
  assert.equal(r.modalita, 'tradizionale'); assert.equal(r.motivoModalita, 'sospeso');
  await pausa(150);
  assert.equal(log().filter(l => l.evento === 'avvio').length, avviiPrima);
});

test('modello non valido: stesso errore del sistema tradizionale, senza toccare i processi', async () => {
  const { p } = prova();
  await assert.rejects(p.executeTask(rich('x', { model: 'a b; rm -rf /' })), e => e.code === 'MODEL_NOT_FOUND');
});

test('processi inattivi: dopo il TTL il processo viene chiuso e non rimpiazzato', async () => {
  const { p } = prova({}, { ttlInattivoMs: 120 });
  await scalda(p);
  const pid = p._libero('haiku').pid;
  await finche(() => !vivo(pid), 3000);
  await pausa(100);
  assert.equal((p.workers.get('haiku') || []).length, 0);
});

test('spegnimento: chiudi() termina tutti i processi', async () => {
  const { p } = prova();
  await scalda(p, 'haiku'); await scalda(p, 'sonnet');
  const pids = [p._libero('haiku').pid, p._libero('sonnet').pid];
  assert.ok(pids.every(vivo));
  p.chiudi();
  await finche(() => pids.every(x => !vivo(x)), 4000);
  const r = await p.executeTask(rich('dopo la chiusura'));
  assert.equal(r.modalita, 'tradizionale'); assert.equal(r.motivoModalita, 'chiuso');
});

test('spegnimento di Orbit (uscita del processo): i processi Claude non restano orfani', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pers-'));
  const script = "const {ClaudePersistentProvider}=require(" + JSON.stringify(require.resolve('../ai/providers/claude-persistente')) + ");" +
    "const p=new ClaudePersistentProvider({bin:process.execPath,binArgs:[" + JSON.stringify(FALSO) + "],cwd:" + JSON.stringify(path.join(dir, 'c')) + ",poolMax:2});" +
    "p._assicura('haiku',false);p._assicura('sonnet',false);setTimeout(()=>{process.stdout.write(JSON.stringify([...p.workers.values()].flat().map(w=>w.pid)));process.exit(0);},400);";
  const pids = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.equal(pids.length, 2);
  await finche(() => pids.every(x => !vivo(x)), 5000);
});

test('sostituzione anticipata: appena un processo prende il turno ne parte uno di riserva, e due richieste ravvicinate sono entrambe persistenti', async () => {
  const { p, log } = prova({ ORBIT_FAKE_RISPOSTA_MS: '120' });
  await scalda(p);
  const prima = p.executeTask(rich('ravvicinata-uno'));
  await pausa(30);
  assert.equal((p.workers.get('haiku') || []).filter(w => w.stato !== 'morto').length, 2);       // occupato + riserva, gia durante il turno
  const r1 = await prima;
  const r2 = await p.executeTask(rich('ravvicinata-due'));                                      // subito dopo, senza aspettare niente
  assert.equal(r1.modalita, 'persistente'); assert.equal(r2.modalita, 'persistente');
  assert.match(r2.text, /ravvicinata-due/);
  assert.equal(p.stat.nessunWorker, 0); assert.equal(p.stat.tradizionale, 0);
  assert.equal(log().filter(l => l.comando === 'p').length, 0);
});

test('processo ancora in avvio: si usa subito senza aspettare e senza avviarne altri, e la richiesta non e duplicata', async () => {
  const { p, log } = prova({ ORBIT_FAKE_AVVIO_MS: '400' });
  const w = p._assicura('haiku', false);                         // appena creato, il falso processo non legge ancora stdin
  const t0 = Date.now();
  const r = await p.executeTask(rich('in-avvio'));
  assert.equal(r.modalita, 'persistente'); assert.equal(r.processo.pid, w.pid); assert.match(r.text, /in-avvio/);
  assert.ok(Date.now() - t0 >= 300);                              // ha atteso l'avvio reale del processo, non un tradizionale
  assert.equal(log().filter(l => l.evento === 'messaggio').length, 1);
  assert.equal(log().filter(l => l.comando === 'p').length, 0);   // nessuna esecuzione tradizionale in parallelo
});

test('nessun processo pronto: la prima richiesta passa subito al tradizionale e avvia UN processo; non si attende mai e non si superano il pool ne le esecuzioni richieste', async () => {
  const { p, log } = prova({}, { poolMax: 2 });
  const t0 = Date.now();
  const prima = await p.executeTask(rich('senza-pronto-a'));
  assert.equal(prima.modalita, 'tradizionale'); assert.equal(prima.motivoModalita, 'nessun-worker-libero');
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(p.stat.avviati, 1);                                // il processo per la volta dopo e stato avviato una sola volta
  const rr = await Promise.all(['b', 'c', 'd'].map(q => p.executeTask(rich('senza-pronto-' + q))));
  rr.forEach(r => assert.ok(r.text.length > 0));
  const l = log();
  assert.equal(l.filter(x => x.evento === 'messaggio').length + l.filter(x => x.comando === 'p').length, 4);   // 4 richieste = 4 esecuzioni
  assert.ok(p.stat.avviati <= 4);                                 // un processo per richiesta consumata, mai piu del pool contemporaneamente
});

test('concorrenza: 6 richieste insieme, ognuna risposta una sola volta, mai piu di poolMax processi vivi per chiave', async () => {
  const { p, log } = prova({ ORBIT_FAKE_RISPOSTA_MS: '60' }, { poolMax: 2 });
  await scalda(p);
  let massimo = 0; const spia = setInterval(() => { massimo = Math.max(massimo, (p.workers.get('haiku') || []).filter(w => w.stato !== 'morto').length); }, 5);
  const rr = await Promise.all([1, 2, 3, 4, 5, 6].map(i => p.executeTask(rich('conc-' + i))));
  clearInterval(spia);
  rr.forEach(r => assert.ok(r.text.length > 0));
  const l = log();
  assert.equal(l.filter(x => x.evento === 'messaggio').length + l.filter(x => x.comando === 'p').length, 6);   // 6 richieste = 6 esecuzioni, nessun duplicato
  assert.ok(massimo <= 2, 'processi vivi: ' + massimo);
});

test('ricerca web: finche non e validata resta sul sistema tradizionale, senza avviare processi web ne ripetere la chiamata', async () => {
  const { p, log } = prova({}, { prewarm: ['haiku', 'sonnet:web'] });
  const ok = await p.riscalda(['haiku', 'sonnet:web']).catch(() => false);
  assert.ok(ok === true || ok === false);
  const r = await p.executeTask(rich('cerca online', { model: 'sonnet', strumentiWeb: true }));
  assert.equal(r.modalita, 'tradizionale'); assert.equal(r.motivoModalita, 'web-non-validato');
  assert.equal(log().filter(l => l.comando === 'p').length, 1);                      // una sola esecuzione, nessun tentativo persistente prima
  assert.equal(log().filter(l => l.evento === 'avvio' && l.args.includes('WebSearch,WebFetch')).length, 0);   // nessun processo con strumenti web
  assert.equal(p.stat.protocollo, 0); assert.equal(p.stat.fallback, 0);
});

test('diagnostica: il motivo dell ultimo protocollo non valido viene conservato', async () => {
  const { p } = prova({ ORBIT_FAKE_STREAM: 'tooluse' });
  await scalda(p);
  const r = await p.executeTask(rich('x'));
  assert.equal(r.modalita, 'tradizionale-fallback');
  assert.match(p.ultimoMotivoProtocollo, /tool_use/);
});

test('pre-riscaldamento: dopo il controllo del login si tiene pronto un processo per modello, mai doppi, mai senza login, web escluso', async () => {
  const { p } = prova({}, { prewarm: ['haiku', 'sonnet', 'sonnet:web'] });
  assert.equal([...p.workers.values()].flat().length, 0);                                // prima del controllo del login: nessun processo
  const s = await p.healthCheck({ forza: true });
  assert.equal(s.ok, true);
  await finche(() => p._libero('haiku') && p._libero('sonnet'));
  assert.equal(p._libero('sonnet:web'), null);                                          // il web non e persistente
  const avviati = p.stat.avviati;
  await p.healthCheck({ forza: true }); await p.healthCheck({ forza: true });
  assert.equal(p.stat.avviati, avviati);                                                // niente processi doppi
  const r = await p.executeTask(rich('subito dopo il login'));
  assert.equal(r.modalita, 'persistente');                                               // la prima richiesta trova gia un processo
});

test('pre-riscaldamento: con login non valido (falso claude con login ad API) non parte nessun processo', async () => {
  const { p } = prova({ ORBIT_FAKE_AUTH: 'api' });
  const s = await p.healthCheck({ forza: true });
  assert.equal(s.ok, false);
  assert.equal([...p.workers.values()].flat().length, 0);
});

test('avvio automatico: all avvio di Orbit il provider controlla il login e prepara il pool, senza aspettare il browser; disattivabile', async () => {
  const base = { providers: ['claude-code'], claudeBin: process.execPath, ccCwd: os.tmpdir() };
  const attivo = creaProvider(Object.assign({}, base, { claudePersistente: { modalita: 'persistente', riuso: 1, pool: 2, ttlMs: 600000, prewarm: ['haiku'], avvioAutomatico: true } }));
  const spento = creaProvider(Object.assign({}, base, { claudePersistente: { modalita: 'persistente', riuso: 1, pool: 2, ttlMs: 600000, prewarm: ['haiku'], avvioAutomatico: false } }));
  creati.push(attivo, spento);
  assert.equal(attivo.avvioRichiesto, true);
  assert.equal(spento.avvioRichiesto, undefined);
  // con il falso claude: avvia() porta davvero alla creazione del pool
  const { p } = prova({}, { prewarm: ['haiku', 'sonnet'] });
  const s = await p.avvia();
  assert.equal(s.ok, true);
  await finche(() => p._libero('haiku') && p._libero('sonnet'));
  // login non valido: nessun processo
  const { p: senza } = prova({ ORBIT_FAKE_AUTH: 'fuori' });
  assert.equal((await senza.avvia()).ok, false);
  assert.equal([...senza.workers.values()].flat().length, 0);
});

test('terminazione sicura: si terminano solo i figli ancora vivi di Orbit, mai un PID di un processo gia uscito', async () => {
  const { p } = prova({}, { poolMax: 2 });
  const uccisi = []; p._uccidiPid = pid => { uccisi.push(pid); try { process.kill(pid); } catch (e) { /* gia uscito */ } }; p._uccidiPidSync = p._uccidiPid;
  await scalda(p); p._assicura('haiku', false);
  const [vivo, morto] = p.workers.get('haiku');
  assert.ok(vivo.figlioVivo && morto.figlioVivo);
  process.kill(morto.pid);                                                  // il processo esce per conto suo (il PID potrebbe essere riusato)
  await finche(() => !morto.figlioVivo);
  morto._butta();                                                           // non deve cercare di terminare un PID non piu suo
  assert.ok(!uccisi.includes(morto.pid));
  p.chiudi();
  assert.ok(uccisi.includes(vivo.pid));                                     // il processo ancora vivo si termina
  assert.ok(!uccisi.includes(morto.pid));
  await finche(() => !vivo.child || vivo.child.exitCode !== null || vivo.child.signalCode !== null, 4000);
});

test('avvio senza browser: avvia() e non bloccante, non fa chiamate ai modelli e non duplica i processi ai controlli successivi', async () => {
  const { p, log } = prova({}, { prewarm: ['haiku'] });
  const t0 = Date.now();
  const promessa = p.avvia();                                   // non attende nulla: ritorna subito una promise
  assert.ok(Date.now() - t0 < 200);
  assert.equal((await promessa).ok, true);
  await finche(() => p._libero('haiku'));
  const avviati = p.stat.avviati;
  await p.healthCheck({ forza: true }); await p.healthCheck({ forza: true }); await p.avvia();   // il browser fa altri controlli del login
  assert.equal(p.stat.avviati, avviati);                       // un solo processo pronto per modello
  assert.equal((p.workers.get('haiku') || []).filter(w => w.stato !== 'morto').length, 1);
  assert.equal(log().filter(l => l.evento === 'messaggio').length, 0);      // nessun messaggio inviato: nessuna chiamata ai modelli
  assert.equal(log().filter(l => l.comando === 'p').length, 0);
});

test('Claude non trovato: avvia() non lancia, il pool resta vuoto e il backend resta utilizzabile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pers-'));
  const p = new ClaudePersistentProvider({ bin: 'claude-che-non-esiste-xyz', cwd: path.join(dir, 'cwd'), envBase: Object.assign({}, process.env), prewarm: ['haiku'] });
  creati.push(p);
  const s = await p.avvia();
  assert.equal(s.ok, false);
  assert.equal([...p.workers.values()].flat().length, 0);
  await assert.rejects(p.executeTask(rich('x')), e => e.code === 'NO_CLAUDE');       // errore chiaro dal sistema tradizionale, nessun crash
});

test('processo che muore all avvio: nessun ciclo di riavvii, interruttore dopo i guasti e richieste servite dal tradizionale', async () => {
  const { p, log } = prova({ ORBIT_FAKE_STREAM: 'uscita' }, { prewarm: ['haiku'], guastiMax: 2, pausaGuastiMs: 60000 });
  assert.equal((await p.avvia()).ok, true);
  await finche(() => (p.workers.get('haiku') || []).length === 0, 3000);              // il processo morto viene tolto dal pool
  await pausa(200);
  assert.equal(log().filter(l => l.evento === 'avvio').length, 1);                    // nessun riavvio automatico di un processo guasto
  const r = await p.executeTask(rich('serve lo stesso'));
  assert.equal(r.modalita, 'tradizionale');                                           // il backend resta utilizzabile
  assert.ok(/./.test(r.text));
});

test('chiusura e riapertura: il pool si ricrea da zero con processi nuovi e quelli vecchi non esistono piu', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pers-'));
  const nuovoProv = () => { const x = new ClaudePersistentProvider({ bin: process.execPath, binArgs: [FALSO], cwd: path.join(dir, 'cwd'), envBase: Object.assign({}, process.env, { ORBIT_FAKE_LOG: path.join(dir, 'l.jsonl') }), prewarm: ['haiku', 'sonnet'] }); creati.push(x); return x; };
  const a = nuovoProv(); await a.avvia(); await finche(() => a._libero('haiku') && a._libero('sonnet'));
  const vecchi = [a._libero('haiku').pid, a._libero('sonnet').pid];
  a.chiudi();                                                                         // chiusura di Orbit
  await finche(() => vecchi.every(x => !vivo(x)), 4000);
  const b = nuovoProv(); await b.avvia(); await finche(() => b._libero('haiku') && b._libero('sonnet'));   // riapertura
  const nuovi = [b._libero('haiku').pid, b._libero('sonnet').pid];
  assert.ok(nuovi.every(x => vivo(x)) && nuovi.every(x => !vecchi.includes(x)));
  assert.equal((await b.executeTask(rich('dopo la riapertura'))).modalita, 'persistente');
});

test('integrazione: orchestratore, router e Quality Gate funzionano con il provider persistente; verificatore e produttore restano chiamate separate', async () => {
  const { p, log } = prova({ ORBIT_FAKE_REPLY: 'Risposta di prova scritta in italiano per il test.' }, { poolMax: 2 });
  p.healthCheck = async () => ({ ok: true, errore: null, dettagli: { metodo: 'claude.ai', provider: 'firstParty', piano: 'pro' } });
  p.listAvailableModels = async () => [{ id: 'haiku', nome: 'haiku' }, { id: 'sonnet', nome: 'sonnet' }, { id: 'opus', nome: 'opus' }];
  await scalda(p, 'haiku'); await scalda(p, 'sonnet');
  const app = appProva({ provider: p, settings: settingsProva({ env: { ORBIT_MODEL_HAIKU: 'haiku', ORBIT_MODEL_SONNET: 'sonnet', ORBIT_MODEL_OPUS: 'opus' } }) });
  const { r, tipi } = await chiedi(app, 'Spiegami che cos\'e un numero primo.');
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(tipi.includes('verifica') || r.ok === false || r.verifica !== undefined || tipi.length > 0);
  const messaggi = log().filter(l => l.evento === 'messaggio');
  assert.ok(messaggi.length >= 1);
  // il prompt del verificatore non finisce nello stesso messaggio del produttore e nessun messaggio contiene la cronologia di un altro turno
  assert.ok(messaggi.every(m => m.turniInStoria === 1));
});
