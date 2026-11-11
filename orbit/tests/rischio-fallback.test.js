'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MockProvider, appProva, settingsProva, chiedi } = require('./helpers');
const { OrbitError } = require('../ai/errors');
const { tierAmmessi, tierPiuVicino } = require('../ai/router/modelli-ammessi');
const { pianifica } = require('../ai/router/router');
const { classifica } = require('../ai/router/classifier');
const HIGH = 'Che dosaggio di farmaco devo prendere?';
const PASS = { status: 'PASS', reason: 'Verifica sintetica superata.' };
const FAIL = { status: 'FAIL', reason: 'Errore nella risposta.', failed_criteria: ['correttezza'] };
const testo = 'Risposta candidata sintetica in italiano.';
const models = tiers => tiers.map(t => ({ id: 'mock-' + t + '-1' }));
const no = () => { throw new OrbitError('MODEL_NOT_FOUND', 'Modello sintetico assente', { retryable: true }); };
const transitorio = () => { throw new OrbitError('SERVER', 'Errore sintetico', { retryable: true }); };
function app(copione = {}, limiti = {}) {
  return appProva({ provider: new MockProvider({ produttore: () => testo, ...copione }), settings: settingsProva({ limiti: { maxRetryApi: 0, ...limiti } }) });
}
async function high(a, messaggio = HIGH, extra = {}) {
  const eventi = [];
  const r = await a.orchestrator.elabora({ messaggio, ...extra, onEvent: e => { eventi.push(e); extra.onEvent?.(e); } });
  const risultato = { r, eventi, tipi: eventi.map(e => e.tipo) };
  assert.equal(risultato.eventi.find(e => e.tipo === 'classificata').rischio, 'high');
  assert.ok(a.provider.chiamate.every(c => !/haiku/i.test(c.model)));
  if (!risultato.r.ok) {
    assert.equal(risultato.r.testo, undefined);
    assert.ok(!risultato.tipi.includes('finale'));
    assert.ok(!a.storage.messaggi(risultato.r.conversazioneId).some(m => m.ruolo === 'assistant'));
  }
  return risultato;
}

test('B0006: regola condivisa indipendente dall ordine, tier sconosciuti ed esclusi', () => {
  const piano = { rischio: 'high' };
  for (const pool of [['haiku', 'opus', 'sonnet'], ['opus', 'haiku', 'sonnet'], ['sonnet', 'haiku', 'opus']]) {
    assert.deepEqual(tierAmmessi(piano, pool), ['sonnet', 'opus']);
    assert.equal(tierPiuVicino('sonnet', pool, piano, new Set(['sonnet'])), 'opus');
  }
  assert.equal(tierPiuVicino('opus', ['sconosciuto', 'haiku'], piano), null);
});

test('B0006: high usa Sonnet per produttore e verificatore', async () => {
  const a = app(); const { r } = await high(a);
  assert.equal(r.ok, true); assert.equal(r.verifica, 'PASS');
  assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-sonnet-1', 'mock-sonnet-1']);
});

test('B0006: high con Sonnet indisponibile usa Opus, senza downgrade', async () => {
  const a = app({ modelli: models(['haiku', 'opus']) }); const { r } = await high(a);
  assert.equal(r.verifica, 'PASS'); assert.equal(r.piano.tierIniziale, 'opus');
  assert.ok(a.provider.chiamate.every(c => c.model === 'mock-opus-1'));
});

test('B0006: high con solo Haiku rifiutato senza invocazioni', async () => {
  const a = app({ modelli: models(['haiku']) }); const { r } = await high(a);
  assert.equal(r.codice, 'NO_MODEL'); assert.equal(a.provider.chiamate.length, 0);
});

test('B0006: MODEL_NOT_FOUND Sonnet passa a Opus e non riprova il modello assente', async () => {
  const a = app({ produttore: ({ model }) => model.includes('sonnet') ? no() : testo });
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-sonnet-1', 'mock-opus-1', 'mock-opus-1']);
});

test('B0006: solo Sonnet diventa indisponibile, nessun candidato o ciclo', async () => {
  const a = app({ modelli: models(['haiku', 'sonnet']), produttore: no });
  const { r } = await high(a); assert.equal(r.ok, false); assert.equal(a.provider.chiamate.length, 1);
});

test('B0006: Sonnet e Opus diventano indisponibili, ciascuno invocato una sola volta', async () => {
  const a = app({ produttore: no }); await high(a);
  assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-sonnet-1', 'mock-opus-1']);
});

test('B0006: fallback Opus verso Sonnet ammesso e verificato', async () => {
  const a = app({ produttore: ({ model }) => model.includes('opus') ? no() : testo });
  const { r } = await high(a, HIGH + ' Usa Opus.'); assert.equal(r.verifica, 'PASS');
  assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-opus-1', 'mock-sonnet-1', 'mock-sonnet-1']);
});

test('B0006: verificatore Sonnet MODEL_NOT_FOUND risolto a Opus', async () => {
  const a = app({ verificatore: ({ model }) => model.includes('sonnet') ? no() : PASS });
  const { r, eventi } = await high(a); assert.equal(r.verifica, 'PASS');
  const v = eventi.find(e => e.tipo === 'esito_verifica').verificatore;
  assert.deepEqual(v, { tierPrevisto: 'sonnet', tier: 'opus', model: 'mock-opus-1' });
});

test('B0006: nessun verificatore ammesso, candidata non consegnata', async () => {
  const a = app({ verificatore: no }); const { r } = await high(a);
  assert.equal(r.ok, false); assert.equal(a.provider.conteggio('produttore'), 1);
  assert.equal(a.provider.conteggio('verificatore'), 2);
});

test('B0006: disponibilita cambia dopo piano, produttore risolto senza chiamare Sonnet', async () => {
  const a = app();
  const { r, eventi } = await high(a, HIGH, { onEvent: e => { if (e.tipo === 'instradata') a.registry.segnalaNonDisponibile('sonnet'); } });
  assert.equal(r.piano.tierIniziale, 'sonnet'); assert.equal(r.verifica, 'PASS');
  assert.equal(eventi.find(e => e.tipo === 'tentativo').tier, 'opus');
  assert.ok(a.provider.chiamate.every(c => c.model.includes('opus')));
});

test('B0006: mutazione tra selezione e invocazione ricontrollata dal gateway', async () => {
  const a = app(); const { r } = await high(a, HIGH, { onEvent: e => { if (e.tipo === 'esecuzione' && e.tier === 'sonnet') a.registry.segnalaNonDisponibile('sonnet'); } });
  assert.equal(r.verifica, 'PASS'); assert.ok(a.provider.chiamate.every(c => c.model.includes('opus')));
});

test('B0006: disponibilita verificatore cambia dopo produzione', async () => {
  let a; a = app({ produttore: () => { a.registry.segnalaNonDisponibile('sonnet'); return testo; } });
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.equal(a.provider.chiamate[1].model, 'mock-opus-1');
});

test('B0006: high senza modelli residui dopo produzione non usa PASS locale', async () => {
  let a; a = app({ produttore: () => { for (const t of ['sonnet', 'opus']) a.registry.segnalaNonDisponibile(t); return testo; } });
  const { r } = await high(a); assert.equal(r.codice, 'NO_MODEL'); assert.equal(a.provider.chiamate.length, 1);
});

test('B0006: errore transitorio produttore ripiega solo su Opus', async () => {
  const a = app({ produttore: ({ model }) => model.includes('sonnet') ? transitorio() : testo });
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.equal(a.provider.chiamate[1].model, 'mock-opus-1');
});

test('B0006: retry gateway dello stesso Sonnet resta ammesso', async () => {
  const a = app({ produttore: ({ n }) => n === 1 ? transitorio() : testo }, { maxRetryApi: 1 });
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.equal(a.provider.conteggio('produttore'), 2);
});

test('B0006: disponibilita cambia durante backoff, niente retry su Sonnet assente', async () => {
  const a = app({ produttore: ({ n }) => n === 1 ? transitorio() : testo }, { maxRetryApi: 2 });
  a.gateway.attendi = async () => a.registry.segnalaNonDisponibile('sonnet');
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.deepEqual(a.provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.model), ['mock-sonnet-1', 'mock-opus-1']);
});

test('B0006: MODEL_NOT_FOUND non ritentato nemmeno quando retryable', async () => {
  const a = app({ produttore: no }, { maxRetryApi: 3 }); await high(a);
  assert.equal(a.provider.chiamate.length, 2);
});

test('B0006: FAIL scala a Opus e termina solo dopo PASS semantico', async () => {
  const a = app({ produttore: ({ model }) => testo + ' ' + model, verificatore: ({ messages }) => messages[0].content.includes('mock-opus-1') ? PASS : FAIL });
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.deepEqual(a.provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.model), ['mock-sonnet-1', 'mock-opus-1']);
});

test('B0006: FAIL definitivo non consegna il candidato high', async () => {
  const a = app({ verificatore: () => FAIL }, { maxTentativi: 2 }); const { r } = await high(a);
  assert.equal(r.codice, 'VERIFICA_HIGH_NON_COMPLETATA'); assert.equal(a.provider.conteggio('produttore'), 2);
});

test('B0006: JSON malformato termina senza candidata utilizzabile', async () => {
  const a = app({ verificatore: () => 'non JSON' }); const { r } = await high(a);
  assert.equal(r.codice, 'VERIFICA_HIGH_NON_COMPLETATA'); assert.equal(a.provider.conteggio('verificatore'), 4);
});

test('B0006: riverifica transitoria resta Sonnet e puo concludere PASS', async () => {
  const a = app({ verificatore: ({ n }) => n === 1 ? transitorio() : PASS });
  const { r } = await high(a); assert.equal(r.verifica, 'PASS'); assert.equal(a.provider.conteggio('verificatore'), 2);
});

test('B0006: budget verifica esaurito non consegna la candidata', async () => {
  const a = app({ produttore: () => ({ text: testo, usage: { inputTokens: 9000, outputTokens: 9000 } }) }, { budgetTokenRichiesta: 5000 });
  const { r } = await high(a); assert.equal(r.ok, false); assert.equal(a.provider.conteggio('verificatore'), 0);
});

test('B0006: abort interrompe prima del verificatore', async () => {
  const ctrl = new AbortController(); const a = app({ produttore: () => { ctrl.abort(); return testo; } });
  const { r } = await high(a, HIGH, { signal: ctrl.signal }); assert.equal(r.codice, 'ABORTED');
  assert.equal(a.provider.conteggio('verificatore'), 0);
});

test('B0006: richiesta esplicita Haiku non abbassa high', async () => {
  const a = app(); const { r } = await high(a, HIGH + ' Usa Haiku.');
  assert.equal(r.piano.tierIniziale, 'sonnet');
});

test('B0006: preferenza profilo sintetico Haiku non abbassa high', async () => {
  const a = app(); a.memoria = a.orchestrator.memoria = {
    leggiNota: () => ({ contenuto: 'Preferenza interamente sintetica: usa sempre Haiku.', titolo: 'Profilo fittizio' }),
    cerca: () => [],
  };
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.match(a.provider.chiamate[0].messages.map(m => m.content).join('\n'), /Preferenza interamente sintetica/);
});

test('B0006: follow-up eredita high e conserva coppia precedente', async () => {
  const a = app(); const { r: primo } = await high(a);
  a.provider.chiamate.length = 0;
  const { r } = await high(a, 'Ora spiegamelo in modo piu semplice', { conversazioneId: primo.conversazioneId });
  assert.equal(r.verifica, 'PASS');
  assert.match(a.provider.chiamate[0].messages.map(m => m.content).join('\n'), /dosaggio/);
});

test('B0006: cambio esplicito high a low e conversazione separata usano Haiku', async () => {
  const a = app(); const { r: primo } = await high(a); a.provider.chiamate.length = 0;
  const { r } = await chiedi(a, 'Cambiamo argomento: come va?', { conversazioneId: primo.conversazioneId });
  assert.equal(r.piano.rischio, 'low'); assert.equal(a.provider.chiamate[0].model, 'mock-haiku-1');
  const b = await chiedi(a, 'come va?'); assert.equal(b.r.piano.rischio, 'low');
});

test('B0006: low ordinario non aggiunge chiamate, fast path mantiene zero AI', async () => {
  const a = app(); await chiedi(a, 'come va?'); assert.equal(a.provider.chiamate.length, 1);
  const b = await chiedi(a, 'Quanto fa 7 per 8?'); assert.equal(b.r.testo, '56.'); assert.equal(a.provider.chiamate.length, 1);
});

test('B0006: diagnostica distingue piano da chiamate effettive del fallback verificatore', async () => {
  const a = app({ verificatore: ({ model }) => model.includes('sonnet') ? no() : PASS });
  const { r } = await high(a); const righe = a.storage.chiamate(r.richiesta);
  assert.equal(r.piano.verifica.tierVerificatore, 'sonnet');
  assert.deepEqual(righe.map(c => [c.tier, c.modello]), a.provider.chiamate.map(c => [c.model.includes('sonnet') ? 'sonnet' : 'opus', c.model]));
});

test('B0006: alias Haiku configurato come Sonnet bloccato prima dell invio', async () => {
  const a = app(); a.settings.modelli.sonnet = a.registry.stato.sonnet.id = 'mock-haiku-1';
  const { r } = await high(a); assert.equal(r.codice, 'MODEL_RISK'); assert.equal(a.provider.chiamate.length, 0);
});

test('B0006: piano high alterato a verifica locale non produce PASS', async () => {
  const a = app(); const { r } = await high(a, HIGH, { onEvent: e => { if (e.tipo === 'instradata') {
    const originale = a.gate.valuta.bind(a.gate);
    a.gate.valuta = arg => { arg.piano.verifica.modo = 'deterministico'; arg.piano.verifica.tierVerificatore = null; return originale(arg); };
  } } });
  assert.equal(r.ok, false); assert.equal(a.provider.conteggio('verificatore'), 0);
});

for (const modulo of ['ai/escalation/policy', 'ai/context', 'entrambi']) test('B0006 audit: import puro ' + modulo + ' e percorsi configurati dopo', () => {
  const { spawnSync } = require('node:child_process');
  const code = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'b0006-import-'));
    const target = require.resolve('./memoria/config');
    assert.equal(require.cache[target], undefined);
    const importati = ${JSON.stringify(modulo === 'entrambi' ? ['ai/escalation/policy', 'ai/context'] : [modulo])};
    for (const nome of importati) require('./orbit/' + nome);
    assert.equal(require.cache[target], undefined);
    assert.equal(require.cache[require.resolve('./orbit/config')], undefined);
    assert.deepEqual(fs.readdirSync(base), []);
    process.env.ORBIT_VAULT_PATH = path.join(base, 'vault');
    process.env.ORBIT_INDEX_DIR = path.join(base, 'indice');
    fs.mkdirSync(path.join(base, 'vault', '.obsidian'), {recursive:true});
    const c = require('./memoria/config');
    assert.equal(c.vaultPath, path.join(base, 'vault'));
    assert.equal(c.indexFile, path.join(base, 'indice', 'indice.sqlite'));
    assert.equal(c.verificaVault().ok, true);
    assert.equal(fs.existsSync(c.indexFile), false);
    fs.rmSync(base, {recursive:true});
  `;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.error, undefined);
});

for (const ruolo of ['produttore', 'verificatore']) test('B0006 audit: modello effettivo Haiku rifiutato per ' + ruolo, async () => {
  const a = app();
  const originale = a.provider.executeTask.bind(a.provider);
  a.provider.executeTask = async req => {
    const r = await originale(req);
    const verifica = /verificatore di qualita/.test(req.system);
    return (ruolo === 'verificatore') === verifica ? { ...r, model: 'claude-haiku-4-5' } : r;
  };
  const { r } = await high(a, ruolo === 'verificatore' ? HIGH + ' Usa Opus.' : HIGH);
  assert.equal(r.codice, 'MODEL_RISK');
  assert.equal(a.provider.chiamate.length, ruolo === 'produttore' ? 1 : 2);
  assert.ok(a.storage.chiamate(r.richiesta).some(c => c.esito === 'errore:MODEL_RISK'));
});

test('B0006 audit: alias non verificabile e nome contenente sonnet non diventano famiglie affidabili', async () => {
  for (const alias of ['modello-interno', 'sonnet-personalizzato', 'claude-haiku-sonnet']) {
    const a = app(); a.registry.stato.sonnet.id = alias; a.provider.modelli.push({ id: alias });
    const { r } = await high(a); assert.equal(r.codice, 'MODEL_RISK'); assert.equal(a.provider.chiamate.length, 0);
  }
});

test('B0006 audit: alias con verifica preesistente affidabile e modelli ufficiali restano ammessi', async () => {
  const { famigliaModello } = require('../ai/router/modelli-ammessi');
  for (const id of ['sonnet', 'claude-sonnet-4-6', 'claude-3-5-sonnet-20241022']) assert.equal(famigliaModello(id), 'sonnet');
  const a = app(); const alias = 'modello-interno';
  a.registry.stato.sonnet.id = alias; a.provider.modelli.push({ id: alias });
  a.provider.verificaModelli = [{ id: alias, verificato: true, disponibile: true, modelloEffettivo: 'claude-sonnet-4-6' }];
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
});

test('B0006 audit: modello non esposto dal provider resta assente nei metadati effettivi', async () => {
  const a = app(); const originale = a.provider.executeTask.bind(a.provider);
  a.provider.executeTask = async req => ({ ...await originale(req), model: req.model, modelReported: null });
  const visti = []; const chiama = a.gateway.chiama.bind(a.gateway);
  a.gateway.chiama = async arg => { const r = await chiama(arg); visti.push(r.modelloSicurezza); return r; };
  const { r } = await high(a); assert.equal(r.verifica, 'PASS');
  assert.ok(visti.every(m => m.restituito === null && m.famigliaRestituita === null && m.famigliaRichiesta === 'sonnet'));
});

test('B0006 audit: tutte le famiglie dichiarate dal provider vengono controllate', async () => {
  const a = app(); const originale = a.provider.executeTask.bind(a.provider);
  a.provider.executeTask = async req => ({ ...await originale(req), modelReported: 'claude-sonnet-4-6', modelsReported: ['claude-sonnet-4-6', 'claude-haiku-4-5'] });
  const { r } = await high(a); assert.equal(r.codice, 'MODEL_RISK'); assert.equal(a.provider.chiamate.length, 1);
});

test('B0006 audit: web high eredita rischio ed esclusioni prima del routing finale', async () => {
  const a = app({ produttore: ({ req, model }) => req.strumentiWeb && model.includes('sonnet') ? no() : testo + '\nFonti: https://example.com/sintetica' });
  a.permessi.impostaAbilitata('web', true);
  const richieste = []; const chiama = a.gateway.chiama.bind(a.gateway);
  a.gateway.chiama = arg => { richieste.push(arg); return chiama(arg); };
  const { r } = await high(a, 'Cerca sul web quale dosaggio di farmaco devo prendere.');
  assert.equal(r.verifica, 'PASS');
  const web = richieste.filter(c => c.ruolo === 'strumento_web');
  assert.deepEqual(web.map(c => c.model), ['mock-sonnet-1', 'mock-opus-1']);
  assert.ok(web.every(c => c.run.piano.rischio === 'high' && c.run.id === r.richiesta));
  assert.ok(a.provider.chiamate.slice(1).every(c => c.model === 'mock-opus-1'));
});

test('B0006 audit: web high senza modelli ammessi non invoca Haiku', async () => {
  const a = app({ modelli: models(['haiku']) }); a.permessi.impostaAbilitata('web', true);
  const { r } = await high(a, 'Cerca sul web quale dosaggio di farmaco devo prendere.');
  assert.equal(r.codice, 'NO_MODEL'); assert.equal(a.provider.chiamate.length, 0);
});

test('B0006 audit: web high esaurisce gli identificatori senza ripetizioni', async () => {
  const a = app({ produttore: no }); a.permessi.impostaAbilitata('web', true);
  const { r } = await high(a, 'Cerca sul web quale dosaggio di farmaco devo prendere.');
  assert.equal(r.codice, 'NO_MODEL');
  assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-sonnet-1', 'mock-opus-1']);
});

test('B0006 audit: contesto web non puo sovrascrivere il rischio del run high', async () => {
  const a = app({ modelli: models(['haiku']) }); await a.registry.inizializza();
  const { creaIntegrazioneWeb } = require('../integrations/web');
  await assert.rejects(creaIntegrazioneWeb(a).strumenti.cerca_web.esegui({ domanda: 'sintetica' }, {
    richiesta: 'sintetica', piano: { rischio: 'low' }, rischio: 'low',
    run: { id: 'sintetica', piano: { rischio: 'high' }, scadenza: Date.now() + 10000, modelliIndisponibili: new Set(), identificatoriIndisponibili: new Set() }
  }), { code: 'NO_MODEL' });
  assert.equal(a.provider.chiamate.length, 0);
});

for (const verificatore of [false, true]) test('B0006 audit: identificatore duplicato non viene ripetuto dopo MODEL_NOT_FOUND, verifica=' + verificatore, async () => {
  const a = app(verificatore ? { verificatore: no } : { produttore: no });
  a.registry.stato.opus.id = 'mock-sonnet-1';
  const { r } = await high(a); assert.equal(r.ok, false);
  assert.equal(a.provider.chiamate.length, verificatore ? 2 : 1);
  assert.equal(a.registry.modello('sonnet'), 'mock-sonnet-1');
});

test('B0006 audit: richieste concorrenti hanno esclusioni indipendenti', async () => {
  let segnala; const assente = new Promise(r => { segnala = r; });
  const a = app({ produttore: async ({ model, messages }) => {
    const contenuto = messages.map(m => m.content).join('\n');
    if (contenuto.includes('Caso A') && model.includes('sonnet')) { segnala(); return no(); }
    if (contenuto.includes('Caso B')) await assente;
    return testo;
  } });
  const [a1, b1] = await Promise.all([chiedi(a, HIGH + ' Caso A.'), chiedi(a, HIGH + ' Caso B.')]);
  assert.equal(a1.r.verifica, 'PASS'); assert.equal(b1.r.verifica, 'PASS');
  const bCalls = a.provider.chiamate.filter(c => c.messages.some(m => m.content.includes('Caso B')));
  assert.ok(bCalls.length >= 2 && bCalls.every(c => c.model === 'mock-sonnet-1'));
  assert.equal(a.registry.modello('sonnet'), 'mock-sonnet-1');
});

test('B0006 audit: identificatore consentito condiviso funziona e web non lo ripete se assente', async () => {
  const a = app(); a.registry.stato.opus.id = 'mock-sonnet-1';
  assert.equal((await high(a, HIGH + ' Usa Opus.')).r.verifica, 'PASS');
  const b = app({ produttore: no }); b.registry.stato.opus.id = 'mock-sonnet-1';
  b.permessi.impostaAbilitata('web', true);
  const { r } = await high(b, 'Cerca sul web quale dosaggio di farmaco devo prendere.');
  assert.equal(r.codice, 'NO_MODEL'); assert.equal(b.provider.chiamate.length, 1);
});

test('B0006 audit: adapter non inventa il modello riportato e conserva tutti gli identificatori', async () => {
  const { ClaudeCodeProvider } = require('../ai/providers/claude-code');
  class Sintetico extends ClaudeCodeProvider {
    async _esegui() { return { out: JSON.stringify({ result: 'ok', usage: {}, modelUsage: this.usageModelli }), code: 0, durataMs: 1, pid: 1 }; }
  }
  const p = new Sintetico({ bin: process.execPath, cwd: require('node:os').tmpdir() });
  const req = { model: 'sonnet', messages: [{ role: 'user', content: 'sintetica' }], maxTokens: 40 };
  assert.equal((await p.executeTask(req)).modelReported, null);
  p.usageModelli = { 'claude-sonnet-4-6': {}, 'claude-haiku-4-5': {} };
  assert.deepEqual((await p.executeTask(req)).modelsReported, Object.keys(p.usageModelli));
});

test('B0006 residue: MODEL_NOT_FOUND del provider low aggiorna il registry e non ripete il modello', async () => {
  const a = app({ produttore: ({ model }) => model === 'mock-haiku-1' ? no() : testo });
  const { r } = await chiedi(a, 'come va?');
  assert.equal(r.verifica, 'PASS'); assert.equal(r.piano.rischio, 'low');
  assert.equal(a.registry.modello('haiku'), null);
  assert.equal(a.provider.chiamate.filter(c => c.model === 'mock-haiku-1').length, 1);
  await chiedi(a, 'come va?');
  assert.equal(a.provider.chiamate.filter(c => c.model === 'mock-haiku-1').length, 1);
});

function chiamataDiretta(a, run, model = 'mock-sonnet-1', tier = 'sonnet') {
  return a.gateway.chiama({ run, ruolo: 'produttore', tentativo: 1, tier, model, system: '', messages: [{ role: 'user', content: 'sintetica' }], maxTokens: 40 });
}

test('B0006 residue: esclusione locale high non cambia la disponibilita globale', async () => {
  const a = app(); await a.registry.inizializza();
  const run = { id: 'locale', piano: { rischio: 'high' }, scadenza: Date.now() + 5000, modelliIndisponibili: new Set(['sonnet']), identificatoriIndisponibili: new Set(['mock-sonnet-1']) };
  await assert.rejects(chiamataDiretta(a, run), { code: 'NO_MODEL' });
  assert.equal(a.provider.chiamate.length, 0); assert.equal(a.registry.modello('sonnet'), 'mock-sonnet-1');
  assert.equal((await high(a)).r.verifica, 'PASS');
});

test('B0006 residue: MODEL_NOT_FOUND locale prima del provider non invalida un identificatore nuovo', async () => {
  const a = app(); await a.registry.inizializza();
  a.registry.stato.haiku.id = 'mock-haiku-2';
  const run = { id: 'mutazione', piano: { rischio: 'low' }, scadenza: Date.now() + 5000 };
  await assert.rejects(chiamataDiretta(a, run, 'mock-haiku-1', 'haiku'), { code: 'MODEL_NOT_FOUND' });
  assert.equal(a.provider.chiamate.length, 0); assert.equal(a.registry.modello('haiku'), 'mock-haiku-2');
});

test('B0006 residue: errore transitorio low non diventa indisponibilita globale', async () => {
  const a = app({ produttore: ({ model }) => model === 'mock-haiku-1' ? transitorio() : testo });
  const { r } = await chiedi(a, 'come va?');
  assert.equal(r.verifica, 'PASS'); assert.equal(a.registry.modello('haiku'), 'mock-haiku-1');
});

test('B0006 residue: identificatore condiviso indisponibile nel percorso low non viene ritentato', async () => {
  const a = app({ produttore: ({ model }) => model === 'mock-haiku-1' ? no() : testo });
  a.registry.stato.sonnet.id = 'mock-haiku-1';
  const { r } = await chiedi(a, 'come va?');
  assert.equal(r.verifica, 'PASS');
  assert.equal(a.registry.modello('haiku'), null); assert.equal(a.registry.modello('sonnet'), null);
  assert.equal(a.provider.chiamate.filter(c => c.model === 'mock-haiku-1').length, 1);
});

test('B0006 residue: strumento generico riceve soltanto richiesta e signal anche con run nelle opzioni', async () => {
  const a = app(); const signal = new AbortController().signal; let args;
  a.integrazioni.registra({ id: 'spia', strumenti: { leggi: { livello: 'lettura', schema: {}, esegui: async (...v) => { args = v; return 'sintetica'; } } } });
  a.permessi.impostaAbilitata('spia', true);
  const r = await a.integrazioni.esegui('spia', 'leggi', {}, { richiesta: 'generica', signal, run: { piano: { rischio: 'high' } } });
  assert.equal(r.ok, true); assert.equal(args.length, 2);
  assert.deepEqual(Object.keys(args[1]).sort(), ['richiesta', 'signal']);
  assert.equal(args[1].richiesta, 'generica'); assert.equal(args[1].signal, signal);
});

test('B0006 residue: canale web minimale fidato e parametri di downgrade respinti', async () => {
  const a = app(); await a.registry.inizializza(); a.registry.segnalaNonDisponibile('sonnet');
  a.permessi.impostaAbilitata('web', true);
  const s = a.integrazioni.integrazioni.get('web').strumenti.cerca_web;
  const esegui = s.esegui; let contesto, sicurezza;
  s.esegui = async (params, ctx, trusted) => { contesto = ctx; sicurezza = trusted; return esegui(params, ctx, trusted); };
  const run = { id: 'web-minimale', piano: { rischio: 'high', altro: 'non inoltrare' }, scadenza: Date.now() + 5000,
    modelliIndisponibili: new Set(), identificatoriIndisponibili: new Set(), privato: 'non inoltrare' };
  const opzioni = { richiesta: run.id, signal: new AbortController().signal };
  const negato = await a.integrazioni.eseguiWeb({ domanda: 'sintetica', run: { piano: { rischio: 'low' } } }, run, opzioni);
  assert.equal(negato.codice, 'PARAMETRI'); assert.equal(a.provider.chiamate.length, 0);
  const r = await a.integrazioni.eseguiWeb({ domanda: 'sintetica' }, run, opzioni);
  assert.equal(r.ok, true); assert.deepEqual(Object.keys(contesto).sort(), ['richiesta', 'signal']);
  assert.equal(Object.isFrozen(sicurezza), true); assert.equal(Object.isFrozen(sicurezza.piano), true);
  assert.deepEqual(sicurezza.piano, { rischio: 'high' }); assert.equal(Object.hasOwn(sicurezza, 'privato'), false);
  assert.deepEqual(Object.keys(sicurezza).sort(), ['id', 'identificatoriIndisponibili', 'modelliIndisponibili', 'onRetry', 'piano', 'scadenza', 'trace']);
  assert.equal(sicurezza.modelliIndisponibili, run.modelliIndisponibili);
  assert.equal(sicurezza.identificatoriIndisponibili, run.identificatoriIndisponibili);
  assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-opus-1']);
});
