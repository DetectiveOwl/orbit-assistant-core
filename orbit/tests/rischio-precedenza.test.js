'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifica } = require('../ai/router/classifier');
const { pianifica } = require('../ai/router/router');
const { calcoloRapido } = require('../ai/quality/aritmetica');
const { MockProvider, settingsProva, appProva, chiedi } = require('./helpers');

const piano = (c, disponibili = ['haiku', 'sonnet', 'opus'], verificaAI = 'auto') => pianifica(c, {
  disponibili, limiti: settingsProva({ limiti: { verificaAI } }).limiti
});
const domande = [
  'Quale farmaco devo prendere?', 'Che dosaggio devo prendere?', 'Come investire i miei risparmi?',
  'Devo firmare questo contratto?', 'Come calcolare le tasse?', 'Posso fare questo bonifico?'
];

test('rischio: saluti diversi non abbassano categoria, tier o verifica delle domande sensibili', () => {
  for (const domanda of domande) for (const saluto of ['Ciao', 'Ehi', 'Salve', 'Buongiorno', 'Grazie', 'Ok']) {
    const senza = classifica(domanda, { haVault: false });
    const con = classifica(saluto + ', ' + domanda, { haVault: false });
    assert.equal(con.rischio, 'high');
    assert.equal(con.categoria, senza.categoria);
    assert.equal(piano(con).tierIniziale, piano(senza).tierIniziale);
    for (const modo of ['auto', 'sempre']) {
      assert.equal(piano(con, undefined, modo).verifica.modo, 'semantico');
      assert.equal(piano(con, undefined, modo).verifica.tierVerificatore, 'sonnet');
    }
  }
});

test('rischio: richieste composte e segnali iniziali, intermedi e finali restano high', () => {
  for (const msg of [
    'Farmaco: ciao, quale scelgo?', 'Ciao, parlami del dosaggio e poi del meteo.',
    'Ciao! Come stai? Quale farmaco devo prendere?', 'Ciao, prima il meteo, poi gli investimenti.',
    'Riscrivi questa frase: ciao, consulta un medico.', 'Ciao, estrai le date dal contratto.',
    'Ciao, quanto fa 7 per 8 per il dosaggio?', '7+8 e poi quale farmaco devo prendere?',
    'Ciao, calcola 7+8 per un pagamento.'
  ]) {
    const c = classifica(msg, { haVault: false });
    const p = piano(c);
    assert.equal(c.rischio, 'high', msg);
    assert.notEqual(c.categoria, 'chitchat', msg);
    assert.notEqual(p.tierIniziale, 'haiku', msg);
    assert.equal(p.verifica.modo, 'semantico', msg);
    assert.equal(calcoloRapido(msg), null, msg);
  }
});

test('rischio: il router protegge anche classificazioni leggere gia marcate high', () => {
  for (const extra of [{ categoria: 'chitchat' }, { espressione: '7+8' }]) {
    const c = { ...classifica('Quale farmaco devo prendere?'), ...extra };
    assert.equal(piano(c).tierIniziale, 'sonnet');
    assert.equal(piano(c).verifica.modo, 'semantico');
  }
});

test('rischio: richiesta esplicita e disponibilita non ripiegano su Haiku', () => {
  assert.equal(piano(classifica('Con Haiku, quale farmaco devo prendere?')).tierIniziale, 'sonnet');
  const c = classifica('Dimostra passo passo il teorema per gli investimenti usando Sonnet');
  assert.equal(c.complessita, 'high');
  assert.equal(piano(c).tierIniziale, 'opus');
  for (const disponibili of [['sonnet'], ['opus'], ['haiku', 'opus']]) {
    const p = piano(classifica('Ciao, quale farmaco devo prendere?'), disponibili);
    assert.notEqual(p.tierIniziale, 'haiku');
    assert.notEqual(p.verifica.tierVerificatore, 'haiku');
  }
  assert.equal(piano(classifica('Quale farmaco devo prendere?'), ['haiku']).codice, 'NO_MODEL');
});

test('rischio: saluti puri e compiti ordinari mantengono il percorso leggero', () => {
  for (const msg of ['Ciao', 'Ciao, come stai?', 'Grazie, a dopo', 'Ok, perfetto', 'Qual è la capitale francese?', 'Traduci: good morning']) {
    const p = piano(classifica(msg, { haVault: false }));
    assert.equal(p.rischio, 'low', msg);
    assert.equal(p.tierIniziale, 'haiku', msg);
    assert.equal(p.verifica.modo, 'deterministico', msg);
  }
});

test('rischio: flusso mock high con e senza saluto usa produttore e verificatore Sonnet', async () => {
  for (const msg of ['Quale farmaco devo prendere?', 'Ciao, quale farmaco devo prendere?']) {
    const app = appProva({ settings: settingsProva({ limiti: { verificaAI: 'auto' } }) });
    try {
      const { r } = await chiedi(app, msg);
      assert.equal(r.verifica, 'PASS');
      assert.deepEqual(app.provider.chiamate.map(c => [c.ruolo, c.model]), [
        ['produttore', 'mock-sonnet-1'], ['verificatore', 'mock-sonnet-1']
      ]);
    } finally { app.storage.chiudi(); }
  }
});

test('rischio: FAIL mantiene escalation Sonnet-Opus e ERROR mantiene riverifica senza PASS', async () => {
  for (const errore of [false, true]) {
    const provider = new MockProvider({ verificatore: ({ n }) => errore ? 'JSON non valido' : n === 1
      ? { status: 'FAIL', reason: 'Incompleta', failed_criteria: ['Completezza'] }
      : { status: 'PASS', reason: 'ok' } });
    const app = appProva({ provider, settings: settingsProva({ limiti: { verificaAI: 'auto' } }) });
    try {
      const { r, eventi } = await chiedi(app, 'Ciao, quale farmaco devo prendere?');
      if (errore) {
        assert.notEqual(r.verifica, 'PASS');
        assert.ok(eventi.some(e => e.tipo === 'esito_verifica' && e.status === 'ERROR'));
        assert.equal(provider.conteggio('produttore'), 1);
        assert.equal(provider.conteggio('verificatore'), 4);
      } else {
        assert.equal(r.verifica, 'PASS');
        assert.equal(r.escalation, 1);
        assert.deepEqual(provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.model), ['mock-sonnet-1', 'mock-opus-1']);
      }
    } finally { app.storage.chiudi(); }
  }
});
