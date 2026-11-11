'use strict';
// Sistema di movimento dell'interfaccia: continuita (niente salti), interrompibilita, incatenamento rete/contenitore,
// nodi "memoria" solo con note reali, movimento ridotto.
const test = require('node:test');
const assert = require('node:assert');
const { Movimento, geometriaPannello, PARAMETRI } = require('../public/orbit-motion');
const CS = require('../public/core-state');

test('fonti: gli eventi aggiungono e deduplicano le fonti reali fino alla verifica', () => {
  let s = CS.riduci(CS.iniziale(), {tipo: 'locale:invio'});
  assert.deepEqual(s.connessioni, []);
  s = CS.riduci(s, {tipo: 'strumento', nome: 'web.cerca_web'});
  const prima = s;
  const fine = {tipo: 'strumento_fine', nome: 'web.cerca_web', ok: true, fonti: [{percorso: 'https://example.org', titolo: 'Pagina consultata'}]};
  s = CS.riduci(CS.riduci(s, fine), fine);
  assert.equal(prima.connessioni.length, 1);
  assert.equal(s.connessioni.length, 2);
  assert.equal(s.connessioni[1].padre, s.connessioni[0].id);
  s = CS.riduci(s, {tipo: 'verifica'});
  const m = new Movimento();
  m.imposta(s.nome, [], s.connessioni);
  simula(m, 3);
  assert.equal(m.nodi.filter(n => n.fonte).length, 2);
  assert.ok(m.archi.some(a => a.fonte && a.j >= 0 && a.cresce > .9));
  const pos = posizioni(m);
  simula(m, 1);
  assert.ok(saltoMassimo(pos, posizioni(m)) > .01, 'i nodi devono orbitare');
  s = CS.riduci(s, {tipo: 'esito_verifica', status: 'FAIL'});
  m.imposta(s.nome, [], s.connessioni, s.fallimento);
  assert.equal(m.colore, 'err');
  assert.deepEqual(CS.riduci(s, {tipo: 'interrotta'}).connessioni, []);
});

test('nucleo: riposo viola, ascolto luminoso e fallimento rosso', () => {
  assert.equal(PARAMETRI.idle.colore, 'idle');
  assert.ok(PARAMETRI.listening.luce > PARAMETRI.idle.luce);
  const m = new Movimento();
  m.imposta('tools', [], [], true);
  assert.equal(m.colore, 'err');
  m.imposta('idle');
  assert.equal(m.colore, 'idle');
});

const DT = 1 / 60;
function simula(m, secondi, fn) { for (let t = 0; t < secondi; t += DT) { m.passo(DT); if (fn) fn(m); } }
function posizioni(m) { return m.nodi.map(n => m.posizione(n, [0, 0, 0])); }
function saltoMassimo(a, b) { let s = 0; a.forEach((p, i) => { s = Math.max(s, Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2])); }); return s; }

test('movimento: ogni stato reale ha obiettivi definiti', () => {
  for (const s of CS.STATI) assert.ok(PARAMETRI[s], 'manca ' + s);
});

test('movimento: cambi di stato rapidi e casuali non fanno mai saltare i nodi ne il contenitore', () => {
  const m = new Movimento();
  m.geometria(600, 300);
  const seq = ['thinking', 'retrieving', 'executing', 'quality_checking', 'escalating', 'tools', 'thinking', 'idle', 'listening', 'speaking', 'error', 'paused', 'thinking'];
  let prima = posizioni(m), apPrima = m.m.ap.x, peggiore = 0, peggioreAp = 0;
  for (let i = 0; i < 400; i++) {
    if (i % 7 === 0) m.imposta(seq[(i / 7) % seq.length], ['Matrice inversa', 'Sottospazi']);
    if (i === 150) m.apertura(true);
    if (i === 190) m.apertura(false);   // interruzione a meta apertura
    m.passo(DT);
    const ora = posizioni(m);
    peggiore = Math.max(peggiore, saltoMassimo(prima, ora));
    peggioreAp = Math.max(peggioreAp, Math.abs(m.m.ap.x - apPrima));
    prima = ora; apPrima = m.m.ap.x;
  }
  // a 60 fps nessun nodo si sposta di piu di 0,2 raggi del nucleo in un fotogramma, e l'apertura di piu del 6%
  assert.ok(peggiore < .2, 'salto dei nodi ' + peggiore);
  assert.ok(peggioreAp < .06, 'salto del contenitore ' + peggioreAp);
});

test('movimento: annullare durante l elaborazione fa rientrare subito la rete, senza finire l animazione precedente', () => {
  const m = new Movimento();
  m.imposta('thinking');
  simula(m, .35);
  const e1 = m.emersioneMassima();
  assert.ok(e1 > .2 && e1 < 1, 'rete a meta: ' + e1);
  m.imposta('idle');                    // annullamento: lo stato reale torna a riposo
  m.passo(DT); m.passo(DT);
  const satelliti = PARAMETRI.idle.attivi;                     // a riposo restano solo i satelliti vicini al nucleo
  assert.equal(m.nodi.filter(n => n.e.target === 1).length, satelliti);
  simula(m, 2.5);
  assert.ok(m.nodi.filter(n => n.rango >= satelliti).every(n => n.e.x < .02));
});

test('movimento: apertura immediata con rientro fluido della rete, riemersione solo dopo la chiusura', () => {
  const m = new Movimento();
  m.imposta('executing'); simula(m, 1.5);
  assert.ok(m.emersioneMassima() > .9);
  m.imposta('responding'); m.apertura(true);
  m.passo(DT);
  assert.equal(m.m.ap.target, 1, 'la risposta pronta non aspetta la rete');
  assert.ok(m.m.ap.x > 0 && m.emersioneMassima() > .5);
  let apertoConReteFuori = false;
  simula(m, 3, x => { if (x.m.ap.x > .1 && x.emersioneMassima() > .5) apertoConReteFuori = true; });
  assert.equal(apertoConReteFuori, true, 'le due animazioni avanzano insieme');
  assert.ok(m.m.ap.x > .97);
  // nuova richiesta: si chiude e solo dopo la rete riemerge
  m.apertura(false); m.imposta('thinking');
  let reteConContenitoreAperto = false;
  simula(m, 3, x => { if (x.emersioneMassima() > .3 && x.m.ap.x > .5) reteConContenitoreAperto = true; });
  assert.equal(reteConContenitoreAperto, false);
  assert.ok(m.m.ap.x < .02 && m.emersioneMassima() > .9);
});

test('movimento: nodi "memoria" solo nel recupero reale e solo quanti sono le note trovate', () => {
  const m = new Movimento();
  m.imposta('thinking'); simula(m, 1.5);
  assert.equal(m.istantanea().reali, 0);
  assert.ok(m.nodi.every(n => !n.etichetta));
  m.imposta('retrieving', []); simula(m, 1);
  assert.equal(m.istantanea().reali, 0, 'nessuna nota trovata: nessun nodo reale');
  m.imposta('retrieving', ['Matrice inversa', 'Sottospazi vettoriali']); simula(m, 1.5);
  assert.equal(m.istantanea().reali, 2);
  assert.deepEqual(m.nodi.filter(n => n.etichetta).map(n => n.etichetta).sort(), ['Matrice inversa', 'Sottospazi vettoriali']);
  m.imposta('quality_checking'); simula(m, 1.5);
  assert.equal(m.istantanea().reali, 0);
});

test('movimento: la geometria del contenitore e continua e va dal disco del nucleo al pannello', () => {
  const g0 = geometriaPannello(0, { D: 110, W: 600, H: 300 }), g1 = geometriaPannello(1, { D: 110, W: 600, H: 300 });
  assert.equal(Math.round(g0.w), 110); assert.equal(Math.round(g0.h), 110); assert.equal(Math.round(g0.r), 55);
  assert.equal(g0.cx, 0); assert.equal(g0.testo, 0);
  assert.equal(Math.round(g1.w), 600); assert.equal(Math.round(g1.h), 300); assert.equal(g1.testo, 1); assert.equal(g1.rivela, 1);
  assert.ok(Math.abs(g1.scala - .3) < 1e-6);
  let p = g0;
  for (let a = .005; a <= 1; a += .005) {
    const g = geometriaPannello(a, { D: 110, W: 600, H: 300 });
    assert.ok(Math.abs(g.w - p.w) < 12 && Math.abs(g.h - p.h) < 12 && Math.abs(g.cx - p.cx) < 6 && Math.abs(g.scala - p.scala) < .03, 'discontinuita a ' + a);
    assert.ok(g.r <= Math.min(g.w, g.h) / 2 + 1e-9);
    p = g;
  }
});

test('movimento: le dimensioni di una risposta nuova cambiano in modo continuo anche a contenitore aperto', () => {
  const m = new Movimento();
  m.geometria(520, 200); m.imposta('responding'); m.apertura(true); simula(m, 3);
  m.geometria(680, 420);
  let prima = m.m.H.x, max = 0;
  simula(m, 1.5, x => { max = Math.max(max, Math.abs(x.m.H.x - prima)); prima = x.m.H.x; });
  assert.ok(max < 25, 'passo massimo ' + max);
  assert.ok(Math.abs(m.m.H.x - 420) < 1);
});

test('movimento: con movimento ridotto tutto arriva subito allo stato finale, senza impulsi', () => {
  const m = new Movimento();
  m.ridotto = true;
  m.imposta('thinking'); m.passo(0);
  assert.ok(m.emersioneMassima() > .99);
  assert.ok(m.impulsi.every(p => !p.attivo));
  m.imposta('responding'); m.apertura(true); m.passo(0); m.passo(0);
  assert.ok(m.m.ap.x > .99);
});

test('movimento: a riposo la simulazione si ferma (il disegno puo rallentare)', () => {
  const m = new Movimento();
  m.imposta('thinking'); simula(m, 1);
  m.imposta('idle'); simula(m, 6);
  assert.equal(m.aRiposo(), true);
  m.imposta('thinking'); m.passo(DT);
  assert.equal(m.aRiposo(), false);
});

test('movimento: il tempo del rumore non salta quando cambia la velocita', () => {
  const m = new Movimento();
  let prima = m.tRumore, max = 0;
  ['escalating', 'paused', 'listening', 'idle'].forEach(s => { m.imposta(s); simula(m, .5, x => { max = Math.max(max, x.tRumore - prima); prima = x.tRumore; }); });
  assert.ok(max < .05, 'passo del rumore ' + max);
});
