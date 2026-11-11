'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifica } = require('../ai/router/classifier');
const { pianifica } = require('../ai/router/router');
const { settingsProva } = require('./helpers');

const lim = settingsProva().limiti;
const tutti = ['haiku', 'sonnet', 'opus'];
const piano = (msg, opz = {}) => pianifica(classifica(msg, opz.cls || {}), Object.assign({ disponibili: tutti, limiti: lim, tokenContestoStimati: 300 }, opz.piano || {}));

test('router: saluto breve va a Haiku, con soli controlli locali', () => {
  const p = piano('ciao, come stai?');
  assert.equal(p.stato, 'ok');
  assert.equal(p.tierIniziale, 'haiku');
  assert.equal(p.verifica.modo, 'deterministico');
});

test('router: aritmetica semplice va a Haiku e si verifica ricalcolando in locale', () => {
  const p = piano('quanto fa 12*(3+4)?');
  assert.equal(p.categoria, 'math');
  assert.equal(p.tierIniziale, 'haiku');
  assert.equal(p.verifica.modo, 'deterministico');
  assert.ok(p.verifica.controlli.includes('calcolo'));
  assert.equal(p.espressione, '12*(3+4)');
});

test('router: trasformazione di un testo lungo resta semplice (la lunghezza non conta)', () => {
  const testo = 'Correggi gli errori di questo testo: ' + 'La lezione di oggi era sulle matrici e sui determinanti. '.repeat(60);
  const c = classifica(testo);
  assert.equal(c.categoria, 'transform');
  assert.equal(c.complessita, 'low');
  assert.equal(pianifica(c, { disponibili: tutti, limiti: lim, tokenContestoStimati: 300 }).tierIniziale, 'haiku');
});

test('router: domanda breve ma difficile (dimostrazione) non va a Haiku', () => {
  const p = piano('Dimostra il teorema di Rouche-Capelli');
  assert.equal(p.categoria, 'math');
  assert.notEqual(p.tierIniziale, 'haiku');
});

test('router: dimostrazione passo passo con vincoli parte da Opus', () => {
  const p = piano('Dimostra in modo rigoroso, passo passo, che una matrice senza autovalori nulli e invertibile. Spiega perche, e se la matrice fosse singolare?');
  assert.equal(p.tierIniziale, 'opus');
  assert.deepEqual(p.escalation.livelli, []);
});

test('router: compito di media complessita va a Sonnet con Opus come escalation', () => {
  const p = piano('Confronta pro e contro di studiare Analisi 1 prima o dopo FAM e spiegami perche');
  assert.equal(p.tierIniziale, 'sonnet');
  assert.deepEqual(p.escalation.livelli, ['opus']);
  assert.equal(p.verifica.modo, 'semantico');
});

test('router: Haiku iniziale ha Sonnet e Opus come livelli successivi', () => {
  const p = piano('Riassumi in breve: i vettori linearmente indipendenti non si scrivono come combinazione degli altri.');
  assert.equal(p.tierIniziale, 'haiku');
  assert.deepEqual(p.escalation.livelli, ['sonnet', 'opus']);
});

test('router: modello richiesto esplicitamente dall utente', () => {
  assert.equal(piano('usa Opus per dirmi cosa e una base').tierIniziale, 'opus');
});

test('router: modello non disponibile, scala al livello piu vicino', () => {
  const p = piano('Riassumi in breve: i vettori sono elementi di uno spazio.', { piano: { disponibili: ['sonnet', 'opus'] } });
  assert.equal(p.tierIniziale, 'sonnet');
  assert.match(p.motivo, /non disponibile/);
});

test('router: nessun modello disponibile, richiesta rifiutata', () => {
  const p = piano('ciao', { piano: { disponibili: [] } });
  assert.equal(p.stato, 'rifiutato');
  assert.equal(p.codice, 'NO_MODEL');
});

test('router: budget insufficiente per il contesto, richiesta rifiutata senza chiamate', () => {
  const p = piano('Riassumi in breve questo', { piano: { tokenContestoStimati: 999999 } });
  assert.equal(p.stato, 'rifiutato');
  assert.equal(p.codice, 'BUDGET');
});

test('router: in modalita auto un compito semplice non chiede la verifica AI, uno a rischio si', () => {
  const l = Object.assign({}, lim, { verificaAI: 'auto' });
  const semplice = pianifica(classifica('Riassumi in breve: la matrice identita lascia invariato ogni vettore.'), { disponibili: tutti, limiti: l, tokenContestoStimati: 300 });
  assert.equal(semplice.verifica.modo, 'deterministico');
  const rischio = pianifica(classifica('Che dosaggio di farmaco devo prendere?'), { disponibili: tutti, limiti: l, tokenContestoStimati: 300 });
  assert.equal(rischio.verifica.modo, 'semantico');
  const note = pianifica(classifica('Cosa c\'e scritto nei miei appunti di FAM su Rouche?'), { disponibili: tutti, limiti: l, tokenContestoStimati: 800 });
  assert.equal(note.verifica.modo, 'semantico');
});

test('router: richiesta ambigua senza contesto viene segnalata prima di spendere token', () => {
  assert.equal(classifica('fallo', { storia: 0 }).ambigua, true);
  assert.equal(classifica('riassumi questo', { storia: 0, haVault: false }).ambigua, true);
  assert.equal(classifica('fallo', { storia: 3 }).ambigua, false);
});

test('router: domande sugli appunti attivano la memoria del vault', () => {
  const c = classifica('Cosa c\'e scritto nei miei appunti di FAM sul teorema di Rouche?');
  assert.equal(c.richiamaVault, true);
  const p = pianifica(c, { disponibili: tutti, limiti: lim, tokenContestoStimati: 800 });
  assert.equal(p.agente, 'memoria');
  assert.ok(p.verifica.controlli.includes('fonti_citate'));
});

test('router: argomenti ad alto rischio non partono da Haiku', () => {
  const p = piano('Che dosaggio di farmaco devo prendere?');
  assert.equal(classifica('Che dosaggio di farmaco devo prendere?').rischio, 'high');
  assert.notEqual(p.tierIniziale, 'haiku');
});

test('router: "cosa devo fare oggi" e una richiesta sul piano e richiama il vault (prima non lo faceva)', () => {
  for (const m of ['cosa devo fare oggi', 'Cosa devo fare oggi?']) {
    const c = classifica(m);
    assert.equal(c.pianoGiorno, true, m);
    assert.equal(c.richiamaVault, true, m);
    assert.equal(c.categoria, 'planning', m);
  }
  // Dal passo 1 della memoria: lo stato di avanzamento e la data di un esame non sono "il piano della giornata"
  // (allegavano tutto il piano di studio), ma richiamano comunque il vault.
  const stato = classifica('a che punto sono con FAM');
  assert.equal(stato.pianoGiorno, false); assert.equal(stato.statoStudio, true); assert.equal(stato.richiamaVault, true); assert.equal(stato.categoria, 'planning');
  const data = classifica('quando e il parziale di analisi');
  assert.equal(data.pianoGiorno, false); assert.equal(data.dataEvento, true); assert.equal(data.richiamaVault, true);
  assert.equal(classifica('ciao').richiamaVault, false);
  assert.equal(classifica('Spiegami perche il cielo e azzurro').cercaNelVault, true);   // domanda generica: si cerca comunque tra le note
  assert.equal(classifica('quanto fa 3+4').cercaNelVault, false);
});
