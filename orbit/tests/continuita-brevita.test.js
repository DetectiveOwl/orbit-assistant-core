'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifica } = require('../ai/router/classifier');
const { costruisci } = require('../ai/context');
const { testoAutonomo } = require('../ai/router/testo-autonomo');
const { istruzioniRichiesta } = require('../ai/agents/registry');
const { AgentExecutor, creaTask } = require('../ai/agents/executor');
const { appProva, settingsProva, chiedi } = require('./helpers');
const coppia = (q, a) => [{ ruolo: 'user', contenuto: q }, { ruolo: 'assistant', contenuto: a }];
const matrice = coppia('Spiegami una matrice invertibile', 'Una matrice invertibile ha una trasformazione inversa.');
const high = coppia('Come scegliere questi investimenti?', 'La scelta richiede attenzione ai rischi.');
const cls = (q, storia = matrice) => classifica(q, { storia, haVault: false });
const casi = [
  ['Spiegamelo in modo più semplice', 'analysis', 'Semplificazione richiesta'],
  ['Ora spiegamelo ancora più semplicemente, usando un esempio', 'analysis', 'Semplificazione richiesta'],
  ['Semplificalo', 'transform', 'Semplificazione richiesta'],
  ['Riformula la risposta precedente in modo semplice, usando un esempio e conservando le informazioni necessarie per capire senza ripetizioni', 'transform', 'Semplificazione richiesta'],
  ['Riassumi la risposta precedente', 'summary', 'Brevita richiesta'],
  ['Spiegamelo in due frasi', 'analysis', 'Brevita richiesta'],
  ['Approfondisci la risposta precedente', 'analysis', 'Approfondimento richiesto'],
  ['Ora approfondisci la risposta precedente con motivazioni ed esempi', 'analysis', 'Approfondimento richiesto']
];

for (const [q, categoria, istruzione] of casi) test('C1: riferimento e istruzioni per ' + q, () => {
  const c = cls(q);
  assert.equal(c.categoria, categoria);
  assert.equal(c.riferimento.stato, 'chiaro');
  assert.deepEqual(c.riferimento.necessari, [0]);
  assert.equal(c.serveStoria, true);
  assert.equal(testoAutonomo(q, c), false);
  assert.ok(istruzioniRichiesta(q).includes(istruzione));
  const ctx = costruisci({ messaggio: q, storia: matrice, classificazione: c, maxInputToken: 8000 });
  assert.ok(ctx.messaggi.some(m => m.content.includes(matrice[0].contenuto)));
  assert.ok(ctx.messaggi.some(m => m.content.includes(matrice[1].contenuto)));
});

test('C1: assenza, ambiguita e cambio di argomento non inventano antecedenti', () => {
  for (const [q] of casi) assert.equal(cls(q, []).ambigua, true, q);
  const storia = [...matrice, ...coppia('Spiegami il ciclo dell acqua', 'Evaporazione e condensazione.')];
  assert.equal(cls('Semplifica quello di prima', storia).riferimento.stato, 'ambiguo');
  assert.equal(cls('Cambiamo argomento: spiegami brevemente il ciclo dell acqua', high).rischio, 'low');
  assert.match(istruzioniRichiesta('Cambiamo argomento: spiegami brevemente il ciclo dell acqua'), /Brevita richiesta/);
  assert.equal(cls('Approfondisci il ciclo dell acqua', high).riferimento.stato, 'autonoma');
});

test('C1: rischio high conservato anche per semplificazioni lunghe e approfondimenti', () => {
  for (const [q] of casi) assert.equal(cls(q, high).rischio, 'high', q);
  assert.equal(cls('Spiegami dettagliatamente una matrice invertibile', []).riferimento.stato, 'autonoma');
  assert.match(istruzioniRichiesta('Spiegami dettagliatamente una matrice invertibile'), /Approfondimento richiesto/);
  assert.doesNotMatch(istruzioniRichiesta('Approfondisci la risposta precedente'), /Brevita richiesta|mantieni la risposta concisa/);
});

test('C1: testo incollato e istruzioni negate non vengono scambiati per lo stile richiesto', () => {
  assert.equal(istruzioniRichiesta('Traduci in inglese: rispondi brevemente'), '');
  assert.equal(istruzioniRichiesta('Spiegami questo testo: approfondisci e rispondi brevemente'), '');
  assert.equal(istruzioniRichiesta('Non rispondere brevemente, spiega tutto'), '');
  assert.equal(istruzioniRichiesta('Spiegami senza semplificare la dimostrazione'), '');
  assert.equal(istruzioniRichiesta('Spiegami in modo non breve la matrice'), '');
  assert.match(istruzioniRichiesta('Rispondi brevemente'), /Brevita richiesta/);
});

test('C1: prompt effettivo prevale sul profilo dettagliato senza ridurre il budget o alterare voce e JSON', async () => {
  const q = 'Spiegamelo in due frasi';
  const piano = { agente: 'ragionamento', categoria: 'analysis', criteri: ['Corretto'], budget: { maxOutput: 2000, tokenTentativo: 8000 } };
  const contesto = { messaggi: [{ role: 'user', content: '<profilo>Preferisce risposte dettagliate.</profilo>\n' + q }] };
  for (const voce of [false, true]) {
    let chiamate = 0;
    const executor = new AgentExecutor({ gateway: { chiama: async req => {
      chiamate++;
      assert.match(req.system, /prevalgono sulle preferenze del profilo/);
      assert.match(req.system, /Brevita richiesta/);
      assert.match(req.messages[0].content, /Preferisce risposte dettagliate/);
      assert.equal(req.maxTokens, voce ? 350 : 2000);
      if (voce) assert.match(req.system, /Mai percorsi di file/);
      return { text: 'Risposta fixture.' };
    } } });
    await executor.esegui(creaTask({ messaggio: q, piano, contesto, voce }), {});
    assert.equal(chiamate, 1);
  }
  const task = creaTask({ messaggio: q, piano: { ...piano, attesoJson: true }, contesto });
  assert.equal(task.formatoAtteso, 'json');
});

test('C1: flusso completo mock sceglie agente corretto e mantiene Gate e numero di chiamate', async () => {
  for (const [q, categoria, istruzione] of casi) {
    for (const storia of [matrice, high]) {
      const a = appProva({ settings: settingsProva({ limiti: { verificaAI: 'auto' } }) });
      try {
        const conv = a.storage.creaConversazione();
        for (const m of storia) a.storage.aggiungiMessaggio({ conversazione: conv.id, ...m });
        const { r } = await chiedi(a, q, { conversazioneId: conv.id });
        assert.equal(r.verifica, 'PASS', q);
        assert.equal(r.piano.agente, ['summary', 'transform'].includes(categoria) ? 'testo' : 'ragionamento');
        assert.equal(a.provider.chiamate.length, storia === high ? 2 : 1);
        assert.ok(a.provider.chiamate[0].system.includes(istruzione));
        assert.equal(r.piano.verifica.modo, storia === high ? 'semantico' : 'deterministico');
        if (storia === high) assert.notEqual(r.piano.tierIniziale, 'haiku');
      } finally { a.storage.chiudi(); }
    }
  }
});

test('C1: antecedente fuori budget, conversazioni isolate e fast path non richiedono chiamate aggiuntive', async () => {
  const a = appProva();
  try {
    const conv = a.storage.creaConversazione();
    for (const m of coppia('Spiegami gli investimenti', 'Risposta enorme '.repeat(3000))) a.storage.aggiungiMessaggio({ conversazione: conv.id, ...m });
    assert.equal((await chiedi(a, 'Approfondisci la risposta precedente', { conversazioneId: conv.id })).r.verifica, 'CHIARIMENTO');
    assert.equal((await chiedi(a, 'Semplificalo')).r.verifica, 'CHIARIMENTO');
    assert.equal(a.provider.chiamate.length, 0);
    assert.equal((await chiedi(a, 'Quanto fa 7 per 8?')).r.testo, '56.');
    assert.equal(a.provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});
