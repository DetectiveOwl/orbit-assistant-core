'use strict';
// Benchmark ripetibile con DOM e tempi simulati, nessun modello e nessun motore vocale.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { ambienteUI } = require('../tests/performance-ui-fixture');
const { PerformanceTrace, statistiche } = require('../performance');
const { Movimento } = require('../public/orbit-motion');

async function misuraUI(sorgente) {
  const ritardi = [];
  for (let i = 0; i < 30; i++) {
    const ui = ambienteUI(sorgente); await ui.scarica();
    await ui.invia([{ tipo: 'classificazione' }, { tipo: 'contesto', vault: true }, { tipo: 'esecuzione' }, { tipo: 'verifica' },
      { tipo: 'finale', testo: 'Risposta verificata.', richiesta: 'req_1234567890abcdef', verifica: 'PASS' }]);
    while (!ui.win.__orbit.stato().aperta && ui.ora < 10000) ui.avanza(10);
    assert.equal(ui.win.__orbit.stato().aperta, true);
    assert.equal(ui.win.__orbit.stato().risposte, 1);
    ritardi.push(ui.ora);
  }
  return statistiche(ritardi);
}

function misuraTracing(attivo) {
  const campioni = [];
  for (let giro = 0; giro < 30; giro++) {
    const p = new PerformanceTrace({ attivo });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const t = p.crea('req_' + i);
      for (let e = 0; e < 20; e++) t?.marca('chiamata_inizio', { chiamata: e, ruolo: 'produttore' });
      t?.finisci(true);
    }
    campioni.push((performance.now() - t0) / 1000);
    assert.ok(p.tracce.size <= 500);
  }
  return statistiche(campioni);
}

(async () => {
  const indice = process.argv.indexOf('--baseline');
  if (indice < 0 || !process.argv[indice + 1]) throw new Error('Specificare --baseline <copia di main ottenuta con git archive>.');
  const base = fs.readFileSync(path.join(process.argv[indice + 1], 'orbit/public/app.js'), 'utf8');
  const dopo = await misuraUI(); const prima = await misuraUI(base);
  const m = new Movimento(); m.imposta('executing'); for (let i = 0; i < 90; i++) m.passo(1 / 60);
  m.imposta('responding'); m.apertura(true); m.passo(1 / 60);
  assert.equal(m.m.ap.target, 1); assert.ok(m.m.ap.x > 0);
  process.stdout.write(JSON.stringify({ tipo: 'simulato', campioniUI: 30, ritardoInserimentoRispostaMs: { prima, dopo },
    paintSimulato60HzMs: 1000 / 30, tracingLocaleMsPerTurno: { spento: misuraTracing(false), attivo: misuraTracing(true) },
    nota: 'Misura la coda UI con clock simulato e il costo del collector locale con clock reale. Nessuna stima della latenza AI reale.' }, null, 2) + '\n');
})().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
