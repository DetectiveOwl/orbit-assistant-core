'use strict';
// Test dell'adapter Claude Code e del contratto ModelExecutionProvider, con un falso `claude`: nessun consumo dell'abbonamento.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeCodeProvider, risolviEseguibile } = require('../ai/providers/claude-code');
const { metodiMancanti } = require('../ai/providers/contract');
const { creaProvider } = require('../ai/providers');
const { OrbitError } = require('../ai/errors');
const { Storage } = require('../storage/db');
const { creaApp } = require('../app');
const { erroriSintassi } = require('../ai/quality/deterministic');
const { MockProvider, settingsProva, appProva, chiedi } = require('./helpers');

const FALSO = path.join(__dirname, 'fake-claude.js');
function prova(envExtra = {}, opzioni = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ad-'));
  const logFile = path.join(dir, 'chiamate.jsonl');
  const envBase = Object.assign({}, process.env, { ORBIT_FAKE_LOG: logFile }, envExtra);
  const p = new ClaudeCodeProvider(Object.assign({ bin: process.execPath, binArgs: [FALSO], cwd: path.join(dir, 'cwd'), envBase }, opzioni));
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { p, log };
}
const RICH = { model: 'haiku', system: 'Sistema', messages: [{ role: 'user', content: 'ciao' }], maxTokens: 100 };

test('contratto: i provider rispettano ModelExecutionProvider e un provider sconosciuto e rifiutato', () => {
  assert.deepEqual(metodiMancanti(prova().p), []);
  assert.deepEqual(metodiMancanti(new MockProvider()), []);
  assert.deepEqual(metodiMancanti({ id: 'x', executeTask() {} }).sort(), ['cancelExecution', 'discoverCapabilities', 'healthCheck', 'listAvailableModels']);
  assert.throws(() => creaProvider({ providers: ['altro-cli'] }), /non supportato/);
  assert.equal(creaProvider({ providers: ['claude-code'], claudeBin: process.execPath, ccCwd: os.tmpdir() }).id, 'claude-code');
});

test('adapter: processo avviato senza shell, il testo dell utente passa solo da stdin', async () => {
  const { p, log } = prova();
  assert.equal(p.usaShell, false);
  const cattivo = 'ciao & calc.exe | echo pwned ; rm -rf / "$(whoami)" %PATH%';
  const r = await p.executeTask(Object.assign({}, RICH, { messages: [{ role: 'user', content: cattivo }] }));
  assert.match(r.text, /falso Claude Code/);
  const c = log().find(x => x.comando === 'p');
  assert.ok(c.stdin.includes(cattivo));
  assert.ok(!c.args.some(a => a.includes('calc.exe') || a.includes('pwned')));
  assert.deepEqual(r.processo.codiceUscita, 0);
  assert.equal(r.provider, 'claude-code');
  assert.ok(r.executionId);
});

test('adapter: codice di uscita non riuscito e stderr gestiti senza inventare una risposta', async () => {
  const { p } = prova({ ORBIT_FAKE_MODE: 'esce2' });
  await assert.rejects(p.executeTask(RICH), e => { assert.equal(e.code, 'BAD_RESPONSE'); assert.equal(e.codiceUscita, 2); assert.equal(e.fatal, false); assert.match(e.message, /errore interno del processo/); return true; });
});

test('adapter: cancelExecution ferma il processo e libera l identificativo', async () => {
  const { p } = prova({ ORBIT_FAKE_MODE: 'lento' });
  const prom = p.executeTask(Object.assign({}, RICH, { executionId: 'exec_prova_1', timeoutMs: 10000 }));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(p.attive.size, 1);
  assert.equal(p.cancelExecution('exec_prova_1'), true);
  await assert.rejects(prom, e => e.code === 'ABORTED');
  assert.equal(p.attive.size, 0);
  assert.equal(p.cancelExecution('exec_prova_1'), false);
});

test('adapter: nessun processo duplicato con lo stesso identificativo', async () => {
  const { p, log } = prova({ ORBIT_FAKE_MODE: 'lento' });
  const a = p.executeTask(Object.assign({}, RICH, { executionId: 'exec_dup', timeoutMs: 10000 }));
  for (let i = 0; i < 100 && log().filter(c => c.comando === 'p').length < 1; i++) await new Promise(r => setTimeout(r, 50));   // attende l'avvio del falso processo (sotto carico supera 300 ms)
  await assert.rejects(p.executeTask(Object.assign({}, RICH, { executionId: 'exec_dup' })), e => e.code === 'DUPLICATA');
  p.cancelExecution('exec_dup');
  await assert.rejects(a, e => e.code === 'ABORTED');
  assert.equal(log().filter(c => c.comando === 'p').length, 1);
});

test('adapter: output troppo grande, processo fermato', async () => {
  const { p } = prova({ ORBIT_FAKE_MODE: 'enorme' }, { maxOutputByte: 1000 });
  await assert.rejects(p.executeTask(RICH), e => e.code === 'OUTPUT_ENORME');
  assert.equal(p.attive.size, 0);
});

test('adapter: scheda delle capacita completa e senza segreti', async () => {
  const { p } = prova({ ANTHROPIC_API_KEY: 'sk-ant-finta' });
  const c = await p.discoverCapabilities();
  assert.equal(c.id, 'claude-code');
  assert.equal(c.autenticazione.ok, true); assert.equal(c.autenticazione.metodo, 'claude.ai'); assert.equal(c.autenticazione.piano, 'pro');
  assert.equal(c.modalitaNonInterattiva, true); assert.equal(c.formatoOutput, 'json'); assert.equal(c.supportaCancellazione, true);
  assert.match(c.versione, /9\.9\.9/);
  assert.ok(c.variabiliApiRimosse.includes('ANTHROPIC_API_KEY'));
  assert.deepEqual(c.modelli.map(m => [m.id, m.verificato]), [['haiku', false], ['sonnet', false], ['opus', false]]);   // senza probe: non verificati
  assert.ok(!JSON.stringify(c).includes('sk-ant-finta'));
  assert.deepEqual(metodiMancanti(p), []);
});

test('adapter: la verifica reale dei modelli prova ogni alias e segna quello rifiutato', async () => {
  const { p, log } = prova({ ORBIT_FAKE_BAD_MODEL: 'opus' });
  const r = await p.listAvailableModels({ probe: true });
  assert.equal(log().filter(c => c.comando === 'p').length, 3);
  assert.deepEqual(r.map(m => [m.id, m.disponibile]), [['haiku', true], ['sonnet', true], ['opus', false]]);
  assert.ok(r.every(m => m.verificato && m.verificatoIl));
  assert.equal((await p.listAvailableModels())[2].disponibile, false);      // il risultato resta in memoria
  const app = creaApp({ settings: settingsProva({ env: { ORBIT_MODEL_HAIKU: '', ORBIT_MODEL_SONNET: '', ORBIT_MODEL_OPUS: '' } }), provider: p, storage: new Storage(':memory:') });
  await app.registry.inizializza();
  assert.equal(app.registry.modello('opus'), null);          // il router non lo useranno
  assert.equal(app.registry.modello('sonnet'), 'sonnet');
  assert.deepEqual(app.registry.disponibili(), ['haiku', 'sonnet']);
});

test('adapter: la verifica dei modelli si ferma ai limiti dell abbonamento senza insistere', async () => {
  const { p, log } = prova({ ORBIT_FAKE_MODE: 'limite' });
  const r = await p.listAvailableModels({ probe: true });
  assert.equal(log().filter(c => c.comando === 'p').length, 1);
  assert.ok(r.every(m => m.disponibile === null && !m.verificato));
});

test('adapter: healthCheck distingue abbonamento, chiave API, provider cloud e logout', async () => {
  assert.equal((await prova().p.healthCheck({ forza: true })).ok, true);
  for (const tipo of ['api', 'bedrock', 'fuori']) assert.equal((await prova({ ORBIT_FAKE_AUTH: tipo }).p.healthCheck({ forza: true })).ok, false, tipo);
});

test('adapter: eseguibile non trovato, errore comprensibile e fatale', async () => {
  const p = new ClaudeCodeProvider({ bin: path.join(os.tmpdir(), 'non-esiste', 'claude.exe'), cwd: os.tmpdir() });
  await assert.rejects(p.executeTask(RICH), e => { assert.equal(e.code, 'NO_CLAUDE'); assert.equal(e.fatal, true); return true; });
});

test('adapter: su Windows lo shim npm claude.cmd viene risolto in claude.exe, senza shell', { skip: process.platform !== 'win32' }, () => {
  const r = risolviEseguibile('claude');
  if (!fs.existsSync(r.exe)) return;                 // Claude Code non installato in questo ambiente
  assert.equal(r.shell, false);
  assert.match(r.exe, /claude\.exe$/i);
});

test('metriche: provider, codice di uscita e fonte dei token registrati; token assenti restano non disponibili', async () => {
  const { p } = prova();
  const app = creaApp({ settings: settingsProva({ limiti: { verificaAI: 'auto' } }), provider: p, storage: new Storage(':memory:') });
  const { r } = await chiedi(app, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  const c = app.storage.chiamate(r.richiesta)[0];
  assert.equal(c.provider, 'claude-code'); assert.equal(c.codice_uscita, 0); assert.equal(c.token_fonte, 'riportati');
  assert.equal(c.token_in, 100); assert.equal(c.token_out, 25);

  const senza = new MockProvider({ produttore: () => ({ text: 'Risposta in italiano senza metriche dal provider.', usage: { inputTokens: null, outputTokens: null } }) });
  const app2 = appProva({ provider: senza, settings: settingsProva({ limiti: { verificaAI: 'auto' } }) });
  const x = await chiedi(app2, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  const c2 = app2.storage.chiamate(x.r.richiesta)[0];
  assert.equal(c2.token_in, null); assert.equal(c2.token_fonte, null);        // mai inventati
  assert.equal(x.r.metriche.costo, null);
});

test('limiti osservati: una chiamata rifiutata per i limiti dell abbonamento viene registrata e mostrata', async () => {
  const { p } = prova({ ORBIT_FAKE_MODE: 'limite' });
  const app = creaApp({ settings: settingsProva(), provider: p, storage: new Storage(':memory:') });
  const { r } = await chiedi(app, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  assert.equal(r.ok, false); assert.equal(r.codice, 'LIMITE_ABBONAMENTO');
  assert.equal(app.storage.limitiRilevati().n, 1);
  assert.equal(app.storage.richiesta(r.richiesta).escalation, 0);            // un limite non e un fallimento di qualita: nessuna escalation finta
});

test('escalation: provider non disponibile non e un fallimento qualitativo e non finge una escalation', async () => {
  const provider = new MockProvider({ produttore: () => { throw new OrbitError('NO_CLAUDE', 'Claude Code non trovato.', { fatal: true }); } });
  const app = appProva({ provider });
  const { r, tipi } = await chiedi(app, 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.');
  assert.equal(r.ok, false); assert.equal(r.codice, 'NO_CLAUDE');
  assert.ok(!tipi.includes('escalation'));
  assert.equal(provider.conteggio('produttore'), 1);
  assert.equal(provider.conteggio('verificatore'), 0);
});

test('codice: controllo di sintassi locale senza eseguire nulla', () => {
  assert.deepEqual(erroriSintassi('```js\nconst a = 1 + 2;\nconsole.log(a);\n```'), []);
  assert.equal(erroriSintassi('```js\nfunction ( {\n```').length, 1);
  assert.equal(erroriSintassi('```json\n{"a": 1,}\n```').length, 1);
  assert.deepEqual(erroriSintassi('```python\nprint(1)\n```'), []);                      // non verificabile in locale: nessuna falsa certezza
  globalThis.__eseguito = false;
  erroriSintassi('```js\nglobalThis.__eseguito = true;\n```');
  assert.equal(globalThis.__eseguito, false);                                              // compilato, mai eseguito
});

test('codice: una risposta con sintassi errata fallisce in locale e fa salire di livello senza una chiamata di verifica', async () => {
  const provider = new MockProvider({ produttore: ({ n }) => (n === 1 ? 'Ecco la funzione in italiano:\n```js\nfunction somma(a, b { return a + b; }\n```' : 'Ecco la funzione corretta in italiano:\n```js\nfunction somma(a, b) { return a + b; }\n```') });
  const app = appProva({ provider });
  const { r } = await chiedi(app, 'Scrivi una funzione javascript che somma due numeri');
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.escalation, 1);
  assert.equal(provider.conteggio('verificatore'), 1);      // solo sul candidato corretto; il primo e stato bocciato dal controllo locale
});
