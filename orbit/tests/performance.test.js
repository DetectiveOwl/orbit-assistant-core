'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PerformanceTrace, statistiche } = require('../performance');
const { appProva, chiedi, settingsProva, MockProvider } = require('./helpers');
const { ambienteUI } = require('./performance-ui-fixture');
const { creaServer } = require('../server');
const { crea } = require('../public/performance');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ClaudeCodeProvider } = require('../ai/providers/claude-code');
const { ClaudePersistentProvider } = require('../ai/providers/claude-persistente');
const { performance } = require('node:perf_hooks');

test('performance: media, mediana e P95 con almeno 20 campioni, assenti distinti da zero', () => {
  assert.deepEqual(statistiche([]), { campioni: 0, media: null, mediana: null, p95: null, min: null, max: null });
  assert.equal(statistiche([0, 2]).mediana, 1);
  assert.equal(statistiche([1, 2, 3]).p95, null);
  assert.deepEqual(statistiche(Array.from({ length: 20 }, (_, i) => i + 1)), { campioni: 20, media: 10.5, mediana: 10.5, p95: 19, min: 1, max: 20 });
});

test('performance: domini separati, dati sanitizzati, buffer limitato e tracing spento', () => {
  let ora = 10;
  const p = new PerformanceTrace({ ora: () => ora });
  const t = p.crea('req_a'); ora = 25;
  t.marca('contesto_pronto', { testo: 'SEGRETO', fonti: ['nota-privata'], token: 'SEGRETO' }); t.finisci(true);
  assert.equal(p.tracce.get('req_a').eventi[0].ms, 0);
  assert.equal(p.tracce.get('req_a').eventi[1].ms, 15);
  assert.equal(JSON.stringify(p.tracce.get('req_a')).includes('SEGRETO'), false);
  p.frontend('req_a', { inviata: 500, ricevuta: 1000, dom: 1001, visibile: 1032, completa: 1032 });
  const r = p.riepilogo().categorie.conversazione;
  assert.equal(r.backend.media, 15); assert.equal(r.ritardoUI.media, 32); assert.equal(r.rispostaCompleta.media, 532);
  assert.throws(() => p.frontend('req_a', { testo: 'SEGRETO' }));
  assert.throws(() => p.frontend('req_a', { inviata: 501 }));
  assert.throws(() => p.frontend('req_a', { audio_primo: Infinity }));
  for (let i = 0; i < 501; i++) p.crea('req_' + i);
  assert.equal(p.tracce.size, 500); assert.equal(p.tracce.has('req_a'), false);
  const off = new PerformanceTrace({ attivo: false }); assert.equal(off.crea('x'), null); assert.equal(off.tracce.size, 0);
});

test('performance: concorrenza, categorie, Quality Gate e nessun contenuto personale', async () => {
  const app = appProva();
  try {
    const risposte = await Promise.all(['Ciao', 'Riassumi in breve: i vettori formano uno spazio.'].map(t => chiedi(app, t)));
    assert.notEqual(risposte[0].r.richiesta, risposte[1].r.richiesta);
    for (const { r, eventi } of risposte) {
      assert.equal(r.verifica, 'PASS'); assert.equal(eventi.filter(e => e.tipo === 'finale').length, 1);
      const trace = app.performanceTrace.tracce.get(r.richiesta);
      assert.ok(trace.eventi.some(e => e.fase === 'esito_verifica'));
      assert.ok(trace.eventi.some(e => e.fase === 'generazione_fine'));
      assert.ok(trace.eventi.every((e, i) => !i || e.ms >= trace.eventi[i - 1].ms));
      assert.equal(JSON.stringify(trace).includes(r.testo), false);
      assert.ok(eventi.every(e => e.richiesta === r.richiesta));
    }
    const p = new PerformanceTrace();
    for (const categoria of ['conversazione', 'memoria', 'strumenti', 'web', 'voce']) {
      const t = p.crea(categoria); t.categoria(categoria); t.finisci(true);
    }
    assert.ok(Object.values(p.riepilogo().categorie).every(c => c.backend.campioni === 1));
  } finally { app.storage.chiudi(); }
});

test('performance: tracing disabilitato non cambia la risposta e non passa callback al provider', async () => {
  const provider = new MockProvider({ produttore: ({ req }) => { assert.equal(req.onPerformance, undefined); return 'Risposta di prova.'; } });
  const app = appProva({ provider, settings: settingsProva({ env: { ORBIT_TRACE: '0' } }) });
  try { assert.equal((await chiedi(app, 'Ciao')).r.ok, true); assert.equal(app.performanceTrace.tracce.size, 0); }
  finally { app.storage.chiudi(); }
});

test('UI: finale immediato, nessun duplicato, paint misurato e chiusura interrompibile', async () => {
  const ui = ambienteUI(); await ui.scarica();
  const ev = [{ tipo: 'classificazione' }, { tipo: 'contesto', vault: true }, { tipo: 'esecuzione' }, { tipo: 'verifica' },
    { tipo: 'finale', testo: 'Risposta verificata.', richiesta: 'req_1234567890abcdef', verifica: 'PASS' }];
  await ui.invia([...ev, ev.at(-1)], true);
  assert.equal(ui.win.__orbit.stato().risposte, 1);
  assert.equal(ui.win.__orbit.stato().aperta, true);
  assert.equal(ui.ora, 0, 'nessun timeout prima di mostrare la risposta');
  assert.equal(ui.elementi.get('risposta').hidden, false);
  assert.match(ui.elementi.get('rTesto').innerHTML, /Risposta verificata/);
  ui.frame(); ui.frame(); await ui.scarica();
  const metriche = ui.richieste.find(r => r.punti)?.punti;
  assert.ok(metriche.visibile > 0 && metriche.visibile < 34);
  assert.equal(metriche.completa, metriche.visibile);
  ui.elementi.get('rChiudi').listeners.click();
  assert.equal(ui.win.__orbit.stato().aperta, false);
});

test('UI: paint cancellato se chiusa o in background, timer monotono e tracing spento', () => {
  const raf = [], inviati = [];
  let ora = 100, valida = true;
  const win = { performance: { now: () => ora }, document: { hidden: false }, requestAnimationFrame: cb => raf.push(cb),
    fetch: async (_, init) => inviati.push(JSON.parse(init.body)), getComputedStyle: () => ({ opacity: '1', visibility: 'visible' }) };
  const t = crea(win, { voce: { parlatoFine: 50, trascrizioneFine: 75 } });
  t.collega('req_1234567890abcdef'); t.marca('inviata');
  t.dipinta({ getBoundingClientRect: () => ({ width: 1, height: 1 }) }, () => valida);
  raf.shift()(); valida = false; ora = 150; raf.shift()();
  assert.equal(inviati.length, 0); assert.equal(t.punti.parlato_fine, 0); assert.equal(t.punti.inviata, 50);
  assert.equal(crea(win, { attivo: false }), null);
});

test('performance HTTP: correlazione, validazione, aggregati e Piper sullo stesso turno', async () => {
  const app = appProva();
  app.tts = { disponibile: () => true, sintetizza: async () => Buffer.from('audio simulato') };
  const prova = creaServer(app, { port: 0 }); await new Promise(r => prova.listen(0, '127.0.0.1', r));
  const port = prova.address().port; await new Promise(r => prova.close(r));
  const server = creaServer(app, { port }); await new Promise(r => server.listen(port, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + port;
  const H = { 'X-Orbit': '1', 'Content-Type': 'application/json' };
  try {
    const chat = await fetch(base + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ message: 'Ciao', voice: true }) });
    const ev = (await chat.text()).split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
    const id = ev.find(e => e.tipo === 'finale').richiesta;
    const post = punti => fetch(base + '/api/performance/' + id, { method: 'POST', headers: H, body: JSON.stringify({ punti }) });
    assert.equal((await post({ inviata: 0, ricevuta: 40, verificata: 40, dom: 41, visibile: 60, completa: 60, sintesi_inizio: 42, audio_primo: 50, audio_fine: 100 })).status, 200);
    assert.equal((await post({ nota: 'SEGRETO' })).status, 400);
    assert.equal((await post({ inviata: -1 })).status, 400);
    assert.equal((await post({ inviata: 0, audio_fine: 20 })).status, 400);
    await fetch(base + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ testo: 'Risposta di prova.', richiesta: id }) });
    const trace = await (await fetch(base + '/api/performance/' + id)).json();
    assert.ok(trace.eventi.some(e => e.fase === 'sintesi_inizio')); assert.ok(trace.eventi.some(e => e.fase === 'sintesi_fine'));
    assert.equal(JSON.stringify(trace).includes('Risposta di prova.'), false);
    const stats = await (await fetch(base + '/api/performance')).json();
    assert.equal(stats.categorie.voce.primoAudio.media, 50);
    assert.equal(stats.categorie.voce.backend.campioni, 1);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); app.storage.chiudi(); }
});

test('performance provider: persistente e tradizionale, primi output correlati anche in concorrenza', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-performance-'));
  const opzioni = { bin: process.execPath, binArgs: [path.join(__dirname, 'fake-claude-stream.js')], cwd: dir,
    envBase: { ...process.env, ORBIT_FAKE_REPLY: 'Risposta italiana simulata.', ORBIT_FAKE_RISPOSTA_MS: '20' }, prewarm: [], poolMax: 2 };
  const persistente = new ClaudePersistentProvider(opzioni), tradizionale = new ClaudeCodeProvider(opzioni);
  try {
    persistente._assicura('haiku', false);
    const richiesta = { model: 'haiku', system: 'Prova', messages: [{ role: 'user', content: 'Ciao' }], maxTokens: 100, timeoutMs: 5000 };
    const eventi = [[], [], []];
    const risultati = await Promise.all([persistente, persistente, tradizionale].map((p, i) => p.executeTask({ ...richiesta, executionId: 'test_' + i,
      onPerformance: fase => eventi[i].push({ fase, ms: performance.now() }) })));
    assert.equal(risultati[0].modalita, 'persistente');
    for (const e of eventi) { assert.ok(e.some(x => x.fase === 'processo_scelto')); assert.equal(e.filter(x => x.fase === 'primo_output').length, 1); }
    assert.equal(eventi[0].filter(x => x.fase === 'primo_testo').length, 1);
    assert.ok(eventi[0].find(x => x.fase === 'primo_testo').ms >= eventi[0].find(x => x.fase === 'primo_output').ms);
    await tradizionale.executeTask({ ...richiesta, onPerformance: () => { throw new Error('Ascoltatore rotto'); } });
    persistente._assicura('haiku', false);
    await persistente.executeTask({ ...richiesta, onPerformance: () => { throw new Error('Ascoltatore rotto'); } });
  } finally { persistente.chiudi(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('performance: retry e escalation conservano le chiamate distinte e consegnano un solo finale', async () => {
  const { OrbitError } = require('../ai/errors');
  const provider = new MockProvider({ produttore: ({ n }) => {
    if (n === 1) throw new OrbitError('OVERLOADED', 'Simulato', { retryable: true });
    return 'Risposta in italiano per il testo.';
  }, verificatore: ({ n }) => n === 1 ? { status: 'FAIL', reason: 'Correggere la risposta', failed_criteria: ['fedelta'], evidence: [], correction_instructions: 'Correggi', confidence: .9 } : { status: 'PASS', reason: 'ok', failed_criteria: [], evidence: [], correction_instructions: '', confidence: .9 } });
  const app = appProva({ provider }); app.gateway.attendi = async () => {};
  try {
    const { r, eventi } = await chiedi(app, 'Riassumi in breve: i vettori formano uno spazio.');
    assert.equal(r.verifica, 'PASS'); assert.equal(eventi.filter(e => e.tipo === 'finale').length, 1);
    const trace = app.performanceTrace.tracce.get(r.richiesta);
    assert.ok(trace.eventi.some(e => e.fase === 'ritento')); assert.ok(trace.eventi.some(e => e.fase === 'escalation'));
    const chiamate = trace.eventi.filter(e => e.fase === 'chiamata_inizio');
    assert.equal(new Set(chiamate.map(e => e.chiamata)).size, chiamate.length);
    assert.equal(chiamate.length, provider.chiamate.length);
  } finally { app.storage.chiudi(); }
});

test('voce: primo audio solo su playing, fine solo a riproduzione completa e stop senza campione falso', async () => {
  const { creaSintesiOrbit } = require('../public/voice');
  const audio = [], eventi = [];
  class Audio {
    constructor() { audio.push(this); }
    play() { return Promise.resolve(); }
    pause() { this.onpause?.(); }
  }
  const win = { Audio, URL: { createObjectURL: () => 'blob:prova', revokeObjectURL() {} }, cancelAnimationFrame() {},
    fetch: async url => url.endsWith('/stato') ? { ok: true, json: async () => ({ disponibile: true }) } : { ok: true, blob: async () => ({}) } };
  const s = creaSintesiOrbit(win); await s.inizializza();
  const parla = () => s.parla('Una sola frase italiana da leggere.', { onSintesi: () => eventi.push('sintesi'), onAudio: () => eventi.push('audio'), onRiproduzioneFine: () => eventi.push('fine') });
  parla(); await new Promise(r => setImmediate(r));
  assert.deepEqual(eventi, ['sintesi']);
  audio[0].onplaying(); audio[0].onplaying(); audio[0].onended(); await new Promise(r => setImmediate(r));
  assert.deepEqual(eventi, ['sintesi', 'audio', 'fine']);
  parla(); await new Promise(r => setImmediate(r)); s.ferma(); await new Promise(r => setImmediate(r));
  assert.deepEqual(eventi, ['sintesi', 'audio', 'fine', 'sintesi']);
});

test('performance: anche le chiamate web ricostruite dagli strumenti ritrovano il turno', async () => {
  const provider = new MockProvider({ produttore: ({ req }) => {
    assert.equal(typeof req.onPerformance, 'function');
    req.onPerformance('primo_output');
    return req.strumentiWeb ? 'Risultato simulato. Fonte: https://example.com' : 'Secondo la ricerca, il risultato e disponibile.';
  } });
  const app = appProva({ provider }); app.permessi.impostaAbilitata('web', true);
  try {
    const { r } = await chiedi(app, 'Cerca sul web le ultime notizie su Orbit.');
    assert.equal(r.ok, true);
    const trace = app.performanceTrace.tracce.get(r.richiesta);
    assert.equal(trace.categoria, 'web');
    assert.ok(trace.eventi.some(e => e.fase === 'primo_output' && e.ruolo === 'strumento_web'));
    assert.equal(trace.eventi.filter(e => e.fase === 'chiamata_inizio').length, provider.chiamate.length);
  } finally { app.storage.chiudi(); }
});
