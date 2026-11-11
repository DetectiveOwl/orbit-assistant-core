'use strict';
// Benchmark con provider e memoria fittizi: le attese AI sono imposte, non rappresentano Claude reale.
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { statistiche } = require('../performance');
const casi = ['Quanto fa 7 per 8?', 'Quanto fa 20 diviso 4?', 'Qual è il prodotto tra 6 e 7?'];
const attesa = ms => new Promise(r => setTimeout(r, ms));

async function misura(radice, dopo) {
  const { MockProvider, appProva, chiedi } = require(path.join(radice, 'orbit/tests/helpers'));
  const durate = []; let chiamate = 0, profilo = 0, retrieval = 0;
  for (let giro = 0; giro < 10; giro++) for (const domanda of casi) {
    const provider = new MockProvider({ produttore: async () => { await attesa(15); return 'Risposta numerica di fixture.'; },
      verificatore: async () => { await attesa(10); return { status: 'PASS', reason: 'Fixture', failed_criteria: [], evidence: [] }; } });
    const memoria = { leggiNota(p) { profilo++; return { percorso: p, contenuto: 'Profilo fittizio.' }; },
      contestoPerDomanda() { retrieval++; return { testo: 'Estratto fittizio.', fonti: [{ percorso: 'fixture.md', titolo: 'Fixture' }] }; } };
    const app = appProva({ provider, memoria });
    try {
      const t = performance.now(); const { r } = await chiedi(app, domanda, { voce: true });
      durate.push(performance.now() - t); assert.equal(r.verifica, 'PASS');
      assert.equal(provider.chiamate.length, dopo ? 0 : 2);
      chiamate += provider.chiamate.length;
    } finally { app.storage.chiudi(); }
  }
  if (dopo) { assert.equal(profilo, 0); assert.equal(retrieval, 0); }
  return { campioni: durate.length, backendLocaleMsConAtteseFittizie: statistiche(durate), chiamateMock: chiamate, lettureProfilo: profilo, retrieval };
}

(async () => {
  const i = process.argv.indexOf('--baseline');
  assert.ok(i >= 0 && process.argv[i + 1], 'Specificare --baseline <snapshot del commit precedente>.');
  const prima = await misura(path.resolve(process.argv[i + 1]), false);
  const dopo = await misura(path.resolve(__dirname, '../..'), true);
  process.stdout.write(JSON.stringify({ tipo: 'simulato', atteseMockMs: { produttore: 15, verificatore: 10 }, prima, dopo,
    nota: 'Clock locale reale, provider e memoria fittizi. Nessuna misura o previsione della latenza Claude, STT, TTS o browser reale.' }, null, 2) + '\n');
})().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
