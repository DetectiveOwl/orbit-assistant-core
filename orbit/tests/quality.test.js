'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { valuta, estraiEspressione, risultatoPresente } = require('../ai/quality/aritmetica');
const { controlla, percorsiCitati } = require('../ai/quality/deterministic');
const { validaEsito } = require('../ai/quality/gate');
const { OrbitError } = require('../ai/errors');
const { MockProvider, appProva } = require('./helpers');
const { classifica } = require('../ai/router/classifier');
const { pianifica } = require('../ai/router/router');

const OK = { status: 'PASS', reason: 'ok', failed_criteria: [], evidence: [], correction_instructions: '', confidence: 0.8 };

function pianoDa(app, msg, cls = {}) {
  return pianifica(classifica(msg, cls), { disponibili: ['haiku', 'sonnet', 'opus'], limiti: app.settings.limiti, tokenContestoStimati: 300 });
}
const run = app => ({ id: 'req_t', signal: new AbortController().signal, scadenza: Date.now() + 60000 });

test('aritmetica: valutatore sicuro e priorita degli operatori', () => {
  assert.equal(valuta('12*(3+4)'), 84);
  assert.equal(valuta('2+3*4'), 14);
  assert.equal(valuta('2^3^2'), 512);
  assert.equal(valuta('-(2+3)*2'), -10);
  assert.equal(valuta('1/0'), null);
  assert.equal(valuta('process.exit()'), null);
  assert.equal(valuta('2+'), null);
  assert.equal(estraiEspressione('quanto fa 12*(3+4)?'), '12*(3+4)');
  assert.equal(estraiEspressione('ciao a tutti'), null);
});

test('aritmetica: il risultato viene riconosciuto con virgola, punto e migliaia', () => {
  assert.ok(risultatoPresente('Il risultato e 84.', 84));
  assert.ok(risultatoPresente('Fa 3,5 in totale', 3.5));
  assert.ok(risultatoPresente('Fa 1.200 esatti', 1200));
  assert.ok(!risultatoPresente('Fa 840', 84));
  assert.ok(!risultatoPresente('Fa 184', 84));
});

test('gate: validazione dello schema del verificatore', () => {
  assert.ok(validaEsito(OK).ok);
  assert.ok(validaEsito({ status: 'FAIL', reason: 'x', failed_criteria: ['c1'] }).ok);
  assert.ok(!validaEsito({ status: 'FAIL', reason: 'x', failed_criteria: [] }).ok);
  assert.ok(!validaEsito({ status: 'BOH', reason: 'x' }).ok);
  assert.ok(!validaEsito({ status: 'PASS' }).ok);
  assert.ok(!validaEsito({ status: 'PASS', reason: 'x', confidence: 3 }).ok);
  assert.ok(!validaEsito('testo').ok);
});

test('controlli deterministici: risposta vuota, troncata e in lingua sbagliata', () => {
  const piano = { categoria: 'qa', verifica: { controlli: ['non_vuota', 'non_troncata', 'lingua'] } };
  assert.equal(controlla({ testo: '  ', stopReason: 'end_turn', piano }).esito, 'FAIL');
  assert.equal(controlla({ testo: 'Una risposta lunga che pero e stata tagliata', stopReason: 'max_tokens', piano }).esito, 'FAIL');
  const inglese = 'The answer is that this is the thing that you can use when you have the data from the table and it is not what you would expect for this case';
  assert.equal(controlla({ testo: inglese, stopReason: 'end_turn', piano, richiesta: 'dimmi' }).esito, 'FAIL');
  assert.equal(controlla({ testo: inglese, stopReason: 'end_turn', piano, richiesta: 'rispondi in inglese' }).esito, 'PASS');
  const it = 'Il teorema dice che il sistema ha soluzione quando il rango della matrice dei coefficienti e uguale a quello della matrice completa.';
  assert.equal(controlla({ testo: it, stopReason: 'end_turn', piano }).esito, 'PASS');
});

test('controlli deterministici: note citate ma non fornite sono un FAIL', () => {
  const piano = { categoria: 'memory', verifica: { controlli: ['fonti_citate'] } };
  const fonti = ['corsi/FAM/rouche.md'];
  assert.equal(controlla({ testo: 'Vedi corsi/FAM/rouche.md per i dettagli.', piano, fonti }).esito, 'PASS');
  assert.equal(controlla({ testo: 'Vedi corsi/FAM/inventata.md', piano, fonti }).esito, 'FAIL');
  assert.equal(controlla({ testo: 'Vedi corsi/Analisi 1/limiti.md', piano, fonti: ['corsi/Analisi 1/limiti.md'] }).esito, 'PASS');
  assert.deepEqual(percorsiCitati('Fonti: scadenze/parziali.md e `corsi/Analisi 1/limiti.md`.').sort(), ['1/limiti.md', 'scadenze/parziali.md']);
});

test('Quality Gate: PASS dal verificatore semantico', async () => {
  const app = appProva({ provider: new MockProvider({ verificatore: () => OK }) });
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'Spiega perche il cielo e azzurro', candidato: { testo: 'Per la diffusione della luce solare nell\'atmosfera, che e piu forte per il blu.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'PASS');
  assert.equal(e.semantico, true);
  assert.equal(app.provider.conteggio('verificatore'), 1);
});

test('Quality Gate: FAIL con criteri e istruzioni di correzione', async () => {
  const fail = { status: 'FAIL', reason: 'Manca un passaggio.', failed_criteria: ['Mostra i passaggi'], evidence: ['salta da A a C'], correction_instructions: 'Aggiungi B.', confidence: 0.7 };
  const app = appProva({ provider: new MockProvider({ verificatore: () => fail }) });
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'x', candidato: { testo: 'Risposta qualunque ma abbastanza lunga da sembrare vera.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'FAIL');
  assert.deepEqual(e.failed_criteria, ['Mostra i passaggi']);
  assert.equal(e.correction_instructions, 'Aggiungi B.');
});

test('Quality Gate: NEEDS_CLARIFICATION', async () => {
  const app = appProva({ provider: new MockProvider({ verificatore: () => ({ status: 'NEEDS_CLARIFICATION', reason: 'Non e chiaro quale corso.' }) }) });
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'x', candidato: { testo: 'Una risposta.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'NEEDS_CLARIFICATION');
});

test('Quality Gate: output malformato del verificatore, un nuovo tentativo e poi ERROR (mai PASS)', async () => {
  const app = appProva({ provider: new MockProvider({ verificatore: () => 'non sono json' }) });
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'x', candidato: { testo: 'Una risposta.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'ERROR');
  assert.equal(app.provider.conteggio('verificatore'), 2);
});

test('Quality Gate: malformato la prima volta, valido la seconda', async () => {
  const app = appProva({ provider: new MockProvider({ verificatore: ({ n }) => (n === 1 ? '```json\n{rotto' : '```json\n' + JSON.stringify(OK) + '\n```') }) });
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'x', candidato: { testo: 'Una risposta.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'PASS');
});

test('Quality Gate: errore del servizio di verifica non diventa PASS', async () => {
  const app = appProva({ provider: new MockProvider({ verificatore: () => { throw new OrbitError('SERVER', 'giu', { retryable: false }); } }) });
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'x', candidato: { testo: 'Una risposta.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'ERROR');
  assert.notEqual(e.status, 'PASS');
});

test('Quality Gate: un controllo deterministico fallito da FAIL senza chiamare il verificatore', async () => {
  const app = appProva();
  const piano = pianoDa(app, 'quanto fa 12*(3+4)?');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'quanto fa 12*(3+4)?', candidato: { testo: 'Fa 80.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'FAIL');
  assert.deepEqual(e.failed_criteria, ['calcolo']);
  assert.match(e.correction_instructions, /84/);
  assert.equal(app.provider.chiamate.length, 0);
});

test('Quality Gate: calcolo corretto passa con soli controlli locali, zero chiamate AI', async () => {
  const app = appProva();
  const piano = pianoDa(app, 'quanto fa 12*(3+4)?');
  const e = await app.gate.valuta({ run: run(app), piano, richiesta: 'x', candidato: { testo: '12 per 7 fa 84.', stopReason: 'end_turn' }, tentativo: 1 });
  assert.equal(e.status, 'PASS');
  assert.equal(e.semantico, false);
  assert.equal(app.provider.chiamate.length, 0);
});

test('Quality Gate: il prompt di verifica contiene criteri e candidato come dati, non l intera cronologia', async () => {
  const app = appProva();
  const piano = pianoDa(app, 'Spiega perche il cielo e azzurro');
  await app.gate.valuta({ run: run(app), piano, richiesta: 'Spiega perche il cielo e azzurro', candidato: { testo: 'Per la diffusione della luce.', stopReason: 'end_turn' }, tentativo: 1 });
  const c = app.provider.chiamate[0];
  assert.equal(c.messages.length, 1);
  assert.match(c.messages[0].content, /<candidato>/);
  assert.match(c.messages[0].content, /Criteri di accettazione/);
});
