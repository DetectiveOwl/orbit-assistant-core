'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EscalationPolicy, AZIONI } = require('../ai/escalation/policy');
const { OrbitError } = require('../ai/errors');
const { MockProvider, appProva, chiedi, settingsProva } = require('./helpers');

const OK = { status: 'PASS', reason: 'ok', failed_criteria: [], evidence: [], correction_instructions: '', confidence: 0.9 };
const KO = { status: 'FAIL', reason: 'Manca un passaggio.', failed_criteria: ['Mostra i passaggi'], evidence: ['salto'], correction_instructions: 'Aggiungi i passaggi.', confidence: 0.8 };
const lungo = 'Spiegami perche la serie armonica diverge e confrontala con la serie armonica generalizzata';   // sonnet iniziale
const semplice = 'Riassumi in breve: la matrice identita lascia invariato ogni vettore.';                         // haiku iniziale

// ---- politica pura ----
const lim = settingsProva().limiti;
const pol = new EscalationPolicy({ limiti: lim });
const pianoH = { tierIniziale: 'haiku', escalation: { livelli: ['sonnet', 'opus'] } };
const pianoO = { tierIniziale: 'opus', escalation: { livelli: [] } };

test('policy: PASS accetta, FAIL da Haiku sale a Sonnet, poi Opus', () => {
  const s = pol.statoIniziale(pianoH);
  s.tentativi = 1;
  assert.equal(pol.dopoVerifica({ esito: { status: 'PASS' }, piano: pianoH, stato: s, residuoToken: 9999 }).azione, AZIONI.ACCETTA);
  const d1 = pol.dopoVerifica({ esito: { status: 'FAIL', reason: 'r', failed_criteria: ['c'] }, piano: pianoH, stato: s, residuoToken: 9999 });
  assert.deepEqual([d1.azione, d1.tier], [AZIONI.ESCALA, 'sonnet']);
  s.escalation = 1; s.tentativi = 2;
  const d2 = pol.dopoVerifica({ esito: { status: 'FAIL', reason: 'r', failed_criteria: ['c'] }, piano: pianoH, stato: s, residuoToken: 9999 });
  assert.deepEqual([d2.azione, d2.tier], [AZIONI.ESCALA, 'opus']);
});

test('policy: da Opus non esiste un livello superiore, un solo tentativo mirato e poi si consegna con limiti', () => {
  const s = pol.statoIniziale(pianoO); s.tentativi = 1;
  const f = { status: 'FAIL', reason: 'r', failed_criteria: ['c'] };
  assert.equal(pol.dopoVerifica({ esito: f, piano: pianoO, stato: s, residuoToken: 9999 }).azione, AZIONI.MIRATO);
  s.mirato = 1; s.tentativi = 2;
  assert.equal(pol.dopoVerifica({ esito: f, piano: pianoO, stato: s, residuoToken: 9999 }).azione, AZIONI.LIMITI);
});

test('policy: tentativi massimi e budget fermano il ciclo', () => {
  const s = pol.statoIniziale(pianoH); s.tentativi = lim.maxTentativi;
  const f = { status: 'FAIL', reason: 'r', failed_criteria: ['c'] };
  assert.equal(pol.dopoVerifica({ esito: f, piano: pianoH, stato: s, residuoToken: 9999 }).motivo, 'max_tentativi');
  s.tentativi = 1;
  assert.equal(pol.dopoVerifica({ esito: f, piano: pianoH, stato: s, residuoToken: 100 }).motivo, 'budget_esaurito');
});

test('policy: chiarimenti, errore di verifica con una sola riverifica', () => {
  const s = pol.statoIniziale(pianoH); s.tentativi = 1;
  assert.equal(pol.dopoVerifica({ esito: { status: 'NEEDS_CLARIFICATION', reason: 'x' }, piano: pianoH, stato: s, residuoToken: 9999 }).azione, AZIONI.CHIARIMENTI);
  const err = { status: 'ERROR', reason: 'x' };
  assert.equal(pol.dopoVerifica({ esito: err, piano: pianoH, stato: s, residuoToken: 9999 }).azione, AZIONI.RIVERIFICA);
  s.riverifiche = 1;
  assert.equal(pol.dopoVerifica({ esito: err, piano: pianoH, stato: s, residuoToken: 9999 }).motivo, 'verifica_non_completata');
});

// ---- flussi completi con provider finto ----
test('flusso: Haiku supera il controllo al primo colpo, nessuna escalation', async () => {
  const app = appProva();
  const { r, tipi } = await chiedi(app, semplice);
  assert.equal(r.ok, true);
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.escalation, 0);
  assert.equal(r.tentativi, 1);
  assert.equal(app.provider.chiamate[0].model, 'mock-haiku-1');
  assert.ok(tipi.indexOf('classificata') < tipi.indexOf('instradata'));
  assert.ok(tipi.indexOf('esecuzione') < tipi.indexOf('verifica'));
  assert.ok(tipi.indexOf('verifica') < tipi.indexOf('finale'));
  assert.equal(r.metriche.chiamate, 2);   // produttore + verificatore
});

test('flusso: Haiku fallisce, Sonnet supera il controllo', async () => {
  const provider = new MockProvider({
    produttore: ({ model }) => (model === 'mock-haiku-1' ? 'Risposta incompleta.' : 'Risposta completa e corretta in italiano per la richiesta.'),
    verificatore: ({ messages }) => (/incompleta/.test(messages[0].content) ? KO : OK)
  });
  const app = appProva({ provider });
  const { r, eventi } = await chiedi(app, semplice);
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.escalation, 1);
  assert.deepEqual(provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.model), ['mock-haiku-1', 'mock-sonnet-1']);
  const esc = eventi.find(e => e.tipo === 'escalation');
  assert.equal(esc.da, 'haiku'); assert.equal(esc.a, 'sonnet');
  assert.deepEqual(esc.criteri, ['Mostra i passaggi']);
  // Il livello superiore riceve risultato precedente, criteri falliti e correzioni.
  const secondo = provider.chiamate.filter(c => c.ruolo === 'produttore')[1];
  const ultimo = secondo.messages[secondo.messages.length - 1].content;
  assert.match(ultimo, /<risultato_precedente>/);
  assert.match(ultimo, /Mostra i passaggi/);
  assert.match(ultimo, /Aggiungi i passaggi/);
});

test('flusso: Haiku e Sonnet falliscono, Opus supera il controllo', async () => {
  const provider = new MockProvider({
    produttore: ({ model }) => 'Versione di ' + model + ' per questa richiesta, scritta in italiano.',
    verificatore: ({ messages }) => (/mock-opus-1/.test(messages[0].content) ? OK : KO)
  });
  const app = appProva({ provider });
  const { r } = await chiedi(app, semplice);
  assert.equal(r.verifica, 'PASS');
  assert.equal(r.escalation, 2);
  assert.equal(r.tentativi, 3);
  assert.deepEqual(provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.model), ['mock-haiku-1', 'mock-sonnet-1', 'mock-opus-1']);
});

test('flusso: Opus fallisce, un solo tentativo mirato e poi risposta dichiarata non verificata', async () => {
  const provider = new MockProvider({ produttore: () => 'Una risposta in italiano che non convince il verificatore.', verificatore: () => KO });
  const app = appProva({ provider });
  const { r } = await chiedi(app, 'usa Opus per dirmi cosa e una base di uno spazio vettoriale');
  assert.equal(r.ok, true);
  assert.equal(r.verifica, 'FAIL');
  assert.match(r.testo, /non ha superato il controllo/);
  assert.equal(provider.conteggio('produttore'), 2);   // Opus + un tentativo mirato, niente cicli
  assert.ok(r.limitazioni);
});

test('flusso: tutti i livelli falliscono, i tentativi restano entro il massimo', async () => {
  const provider = new MockProvider({ produttore: () => 'Una risposta in italiano che non convince nessuno.', verificatore: () => KO });
  const app = appProva({ provider, settings: settingsProva({ limiti: { maxTentativi: 3 } }) });
  const { r } = await chiedi(app, semplice);
  assert.equal(r.verifica, 'FAIL');
  assert.equal(provider.conteggio('produttore'), 3);
  assert.equal(provider.conteggio('verificatore'), 3);
  assert.equal(r.tentativi, 3);
});

test('flusso: ORBIT_MAX_ESCALATIONS=0 non permette di salire di livello', async () => {
  const provider = new MockProvider({ produttore: () => 'Una risposta in italiano che non convince nessuno.', verificatore: () => KO });
  const app = appProva({ provider, settings: settingsProva({ limiti: { maxEscalation: 0 } }) });
  const { r } = await chiedi(app, semplice);
  assert.equal(r.escalation, 0);
  assert.deepEqual([...new Set(provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.model))], ['mock-haiku-1']);
});

test('flusso: budget di token esaurito durante il ciclo, risposta consegnata dichiarando i limiti', async () => {
  const provider = new MockProvider({
    produttore: () => ({ text: 'Una risposta in italiano che non convince il verificatore.', usage: { inputTokens: 900, outputTokens: 900 } }),
    verificatore: () => ({ text: JSON.stringify(KO), usage: { inputTokens: 900, outputTokens: 100 } })
  });
  const app = appProva({ provider, settings: settingsProva({ limiti: { budgetTokenRichiesta: 3000, budgetTokenTentativo: 2500 } }) });
  const { r } = await chiedi(app, semplice);
  assert.equal(r.ok, true);
  assert.notEqual(r.verifica, 'PASS');
  assert.ok(provider.conteggio('produttore') <= 2);
  assert.ok(r.metriche.token <= 3000 + 900);
});

test('flusso: errore API persistente sul produttore, nessun risultato inventato', async () => {
  const provider = new MockProvider({ produttore: () => { throw new OrbitError('SERVER', 'Errore del servizio', { retryable: true, status: 500 }); } });
  const app = appProva({ provider });
  const { r, tipi } = await chiedi(app, semplice);
  assert.equal(r.ok, false);
  assert.ok(['SERVER', 'NO_MODEL'].includes(r.codice));
  assert.ok(tipi.includes('errore'));
  assert.equal(provider.conteggio('verificatore'), 0);
});

test('flusso: sovraccarico transitorio, il gateway ritenta e poi riesce', async () => {
  let n = 0;
  const provider = new MockProvider({ produttore: () => { n++; if (n < 3) throw new OrbitError('RATE_LIMIT', 'rl', { retryable: true, retryAfterMs: 10 }); return 'Risposta in italiano arrivata dopo i tentativi.'; } });
  const app = appProva({ provider, settings: settingsProva({ limiti: { maxRetryApi: 2 } }) });
  const { r, tipi } = await chiedi(app, semplice);
  assert.equal(r.verifica, 'PASS');
  assert.equal(tipi.filter(t => t === 'ritento').length, 2);
});

test('flusso: modello non disponibile viene escluso e si passa a un altro livello', async () => {
  const provider = new MockProvider({ produttore: ({ model }) => { if (model === 'mock-haiku-1') throw new OrbitError('MODEL_NOT_FOUND', 'no'); return 'Risposta in italiano da un altro livello.'; } });
  const app = appProva({ provider });
  const { r } = await chiedi(app, semplice);
  assert.equal(r.verifica, 'PASS');
  assert.notEqual(app.registry.modello('haiku'), 'mock-haiku-1');
});

test('flusso: interruzione da parte dell utente ferma tutto e non salva nessuna risposta', async () => {
  const ctrl = new AbortController();
  const provider = new MockProvider({ produttore: async () => { ctrl.abort(); return 'Risposta tardiva.'; } });
  const app = appProva({ provider });
  const { r, tipi } = await chiedi(app, semplice, { signal: ctrl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.codice, 'ABORTED');
  assert.ok(tipi.includes('interrotta'));
  assert.equal(provider.conteggio('verificatore'), 0);
  const msgs = app.storage.messaggi(r.conversazioneId);
  assert.ok(!msgs.some(m => m.ruolo === 'assistant'));
});

test('flusso: richiesta ambigua, chiarimento senza nessuna chiamata AI', async () => {
  const app = appProva();
  const { r } = await chiedi(app, 'fallo');
  assert.equal(r.ok, true);
  assert.equal(r.verifica, 'CHIARIMENTO');
  assert.equal(app.provider.chiamate.length, 0);
});

test('flusso: NEEDS_CLARIFICATION del verificatore diventa una domanda all utente, senza escalation', async () => {
  const provider = new MockProvider({ verificatore: () => ({ status: 'NEEDS_CLARIFICATION', reason: 'Non e chiaro a quale corso ti riferisci.' }) });
  const app = appProva({ provider });
  const { r } = await chiedi(app, lungo);
  assert.equal(r.verifica, 'CHIARIMENTO');
  assert.match(r.testo, /chiarimento/);
  assert.equal(r.escalation, 0);
  assert.equal(provider.conteggio('produttore'), 1);
});

test('flusso: errore del servizio di verifica, mai presentato come verificato', async () => {
  const provider = new MockProvider({ verificatore: () => { throw new OrbitError('SERVER', 'giu', { retryable: false }); } });
  const app = appProva({ provider });
  const { r } = await chiedi(app, lungo);
  assert.equal(r.ok, true);
  assert.equal(r.verifica, 'NON_VERIFICATA');
  assert.match(r.testo, /non sono riuscito a verificare/);
});

test('flusso: il router sceglie davvero il modello configurato (Sonnet per un compito medio)', async () => {
  const app = appProva();
  const { r } = await chiedi(app, lungo);
  assert.equal(r.piano.tierIniziale, 'sonnet');
  assert.equal(app.provider.chiamate[0].model, 'mock-sonnet-1');
});
