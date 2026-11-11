'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifica, rilevaRischio } = require('../ai/router/classifier');
const { pianifica } = require('../ai/router/router');
const { testoAutonomo } = require('../ai/router/testo-autonomo');
const { costruisciPrompt } = require('../ai/providers/claude-code');
const { OrbitError } = require('../ai/errors');
const { MockProvider, appProva, settingsProva, chiedi } = require('./helpers');
const HIGH = 'Quanto ibuprofene posso prendere?';
const PASS = { status: 'PASS', reason: 'Controllo sintetico.' };
const coppia = (q, a = 'Risposta sintetica senza indicazioni cliniche.') => [{ ruolo: 'user', contenuto: q }, { ruolo: 'assistant', contenuto: a }];
const cls = (q, storia = []) => classifica(q, { storia, haVault: false });
const crea = (copione = {}, limiti = {}) => appProva({ provider: new MockProvider(copione),
  settings: settingsProva({ limiti: { verificaAI: 'auto', maxRetryApi: 0, ...limiti } }) });
function salva(a, storia) {
  const c = a.storage.creaConversazione();
  for (const m of storia) a.storage.aggiungiMessaggio({ conversazione: c.id, ...m });
  return c.id;
}
const positivi = [HIGH, 'Che pillola prendo per dormire?', 'Come distribuisco i risparmi tra ETF e BTC?',
  'Quanto paracetamolo devo assumere?', 'Quante compresse posso prendere?', 'Quale sonnifero consigli per dormire?',
  'Posso combinare aspirina e ibuprofene?', 'Quante compresse al giorno?', 'Come ripartire il capitale tra ETF e obbligazioni?',
  'Quale percentuale dei risparmi destinare al fondo pensione?', 'Conviene comprare Bitcoin?', 'Posso vendere BTC?'];

for (const q of positivi) test('B0005: dominio e intenzione operativa: ' + q, () => {
  for (const testo of [q, 'Ciao, ' + q, 'Parliamo del meteo. Poi: ' + q]) {
    const c = cls(testo);
    assert.equal(c.rischio, 'high');
    assert.match(c.segnali.join('\n'), /rischio: (salute-assunzione-scelta|finanza-allocazione-scelta)/);
    const p = pianifica(c, { disponibili: ['haiku', 'sonnet', 'opus'], limiti: settingsProva().limiti });
    assert.notEqual(p.tierIniziale, 'haiku');
    assert.equal(p.verifica.modo, 'semantico');
    assert.equal(testoAutonomo(testo, c), false);
  }
});

test('B0005: motivazione pura e stabile senza contenuti personali', () => {
  assert.deepEqual(rilevaRischio(HIGH), { rischio: 'high', regola: 'salute-assunzione-scelta' });
  assert.deepEqual(rilevaRischio(null), { rischio: 'low', regola: null });
  const c = cls(HIGH + ' Identificatore privato sintetico ZXQ-123');
  assert.doesNotMatch(JSON.stringify(c.segnali), /ibuprofene|ZXQ-123/);
  assert.deepEqual(rilevaRischio(HIGH), rilevaRischio(HIGH));
});

test('B0005: tutti i segnali high precedenti restano high, incluse menzioni e trasformazioni', () => {
  for (const q of ['medico', 'farmaco', 'dosaggio', 'legale', 'contratto', 'investimento', 'trade republic',
    'azioni', 'criptovaluta', 'fiscale', 'tasse', 'bonifico', 'pagamento', 'Le azioni del personaggio nel videogioco',
    'Traduci: "Consulta un medico"']) {
    assert.equal(cls(q).rischio, 'high', q);
    assert.equal(rilevaRischio(q).regola, 'high-preesistente', q);
  }
});

test('B0005: menzioni, usi figurati, informatici e trasformazioni senza decisione non diventano high', () => {
  for (const q of ['È una pillola amara da mandare giù', 'Spiegami il significato di pillola amara',
    'Che cosa sono i risparmi energetici?', 'Come riduco la memoria occupata dal file pillola.txt?',
    'Correggi il codice che distribuisce i risparmi di memoria', 'Apri il file bitcoin.txt',
    'Che cos è Bitcoin?', 'Qual è il significato della sigla ETF?', 'Traduci in inglese: La pillola è amara.',
    'Traduci in inglese: "Quanto ibuprofene posso prendere?"', 'Riassumi: «Che pillola prendo per dormire?»',
    'Ciao', 'come va?', 'Qual è la capitale francese?']) {
    assert.notEqual(cls(q).rischio, 'high', q);
  }
  assert.equal(cls('Traduci: "Quanto ibuprofene posso prendere?" Poi dimmi quante compresse devo prendere.').rischio, 'high');
});

test('B0005: gli esempi originali attraversano produttore e verificatore ammessi nel flusso completo', async () => {
  for (const q of positivi.slice(0, 3)) {
    const a = crea();
    try {
      const { r, eventi } = await chiedi(a, q);
      assert.equal(r.verifica, 'PASS'); assert.equal(r.piano.rischio, 'high');
      assert.equal(eventi.find(e => e.tipo === 'classificata').rischio, 'high');
      assert.deepEqual(a.provider.chiamate.map(c => [c.ruolo, c.model]), [
        ['produttore', 'mock-sonnet-1'], ['verificatore', 'mock-sonnet-1']]);
    } finally { a.storage.chiudi(); }
  }
});

test('B0005: antecedente sensibile, catena e prompt effettivo conservano coppie e rischio', async () => {
  const a = crea();
  try {
    const id = salva(a, coppia(HIGH));
    for (const q of ['Posso aumentarlo?', 'E se ne prendo due?', 'Ora spiegamelo in modo più semplice']) {
      const { r } = await chiedi(a, q, { conversazioneId: id });
      assert.equal(r.verifica, 'PASS'); assert.equal(r.piano.rischio, 'high');
      assert.equal(r.piano.verifica.modo, 'semantico');
      const req = a.provider.chiamate.filter(c => c.ruolo === 'produttore').at(-1);
      assert.match(costruisciPrompt(req), /Quanto ibuprofene posso prendere/);
      assert.match(costruisciPrompt(req), /Risposta sintetica senza indicazioni cliniche/);
    }
    const c = cls('Posso aumentarlo?', a.storage.messaggi(id));
    assert.deepEqual([...c.riferimento.necessari].sort(), [0, 2, 4, 6]);
    assert.ok(a.provider.chiamate.every(c => c.model === 'mock-sonnet-1'));
  } finally { a.storage.chiudi(); }
});

test('B0005: nuove anafore brevi e lunghe richiedono un antecedente effettivo', () => {
  for (const q of ['Posso aumentarlo?', 'Dovrei ridurlo?', 'Posso prenderlo?', 'E se ne prendo due?',
    'Posso aumentarlo anche domani mantenendo lo stesso intervallo e senza cambiare le altre condizioni?']) {
    assert.equal(cls(q).riferimento.stato, 'assente', q);
    assert.equal(cls(q).ambigua, true, q);
    assert.equal(cls(q, coppia(HIGH)).rischio, 'high', q);
    assert.equal(cls(q, coppia(HIGH)).riferimento.stato, 'chiaro', q);
  }
});

test('B0005: antecedenti multipli, orfani e chiarimenti non inventano una scelta', async () => {
  const a = crea();
  try {
    for (const storia of [[], coppia('Confronta ibuprofene e paracetamolo', 'Sono due opzioni distinte.'),
      [...coppia(HIGH), { ruolo: 'user', contenuto: 'Messaggio non completato' }],
      [{ ruolo: 'user', contenuto: HIGH }, { ruolo: 'assistant', contenuto: 'Quale?', verifica: 'CHIARIMENTO' }]]) {
      const id = salva(a, storia);
      assert.equal((await chiedi(a, 'Posso aumentarlo?', { conversazioneId: id })).r.verifica, 'CHIARIMENTO');
    }
    assert.equal(a.provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});

test('B0005: menzione non operativa precedente non diventa high per ogni pronome', () => {
  const c = cls('Posso aumentarlo?', coppia('Spiegami il risparmio energetico', 'Il risparmio indica minori consumi.'));
  assert.equal(c.riferimento.stato, 'chiaro'); assert.equal(c.rischio, 'low');
  const risposta = cls('Posso aumentarlo?', coppia('Dammi una risposta di esempio', HIGH));
  assert.equal(risposta.rischio, 'high');
  const menzione = coppia('Che cos è ibuprofene?', 'Un principio attivo.');
  assert.equal(cls('Riassumilo', menzione).rischio, 'low');
  assert.equal(cls('Posso aumentarlo?', menzione).rischio, 'high');
  assert.equal(cls('Posso comprarlo?', coppia('Che cos è Bitcoin?', 'Una valuta digitale.')).rischio, 'high');
});

test('B0005: cambio esplicito, domanda autonoma e trasformazione non ereditano high', () => {
  for (const q of ['Cambiamo argomento: raccontami una fiaba', 'Ora parliamo di cucina',
    'Qual è la capitale francese?', 'Traduci in inglese: buongiorno a tutti', 'come va?']) {
    assert.equal(cls(q, coppia(HIGH)).rischio, 'low', q);
    assert.equal(cls(q, coppia(HIGH)).ambigua, false, q);
  }
  assert.equal(cls('Cambiamo argomento: quanto paracetamolo posso prendere?', coppia('Spiegami il cielo')).rischio, 'high');
});

test('B0005: contesto escluso dal budget interrompe prima di strumenti e generazione', async () => {
  const a = crea();
  try {
    const id = salva(a, coppia(HIGH, 'Contesto sintetico lungo '.repeat(2000)));
    a.integrazioni.esegui = () => { throw new Error('Nessuno strumento consentito'); };
    const { r, eventi } = await chiedi(a, 'Posso aumentarlo?', { conversazioneId: id });
    assert.equal(r.verifica, 'CHIARIMENTO'); assert.equal(a.provider.chiamate.length, 0);
    assert.equal(eventi.find(e => e.tipo === 'contesto_pronto').cronologia.stato, 'esclusa');
  } finally { a.storage.chiudi(); }
});

test('B0005: finestra e conversazioni separate non recuperano antecedenti indisponibili', async () => {
  const a = crea();
  try {
    const highId = salva(a, coppia(HIGH));
    assert.equal((await chiedi(a, 'Posso aumentarlo?')).r.verifica, 'CHIARIMENTO');
    const lowId = salva(a, coppia('Spiegami il risparmio energetico', 'Minori consumi.'));
    const low = await chiedi(a, 'Posso aumentarlo?', { conversazioneId: lowId });
    assert.equal(low.r.piano.rischio, 'low');
    assert.doesNotMatch(costruisciPrompt(a.provider.chiamate[0]), /ibuprofene/);
    for (let i = 0; i < 21; i++) for (const m of coppia('Qual è la capitale francese?', 'Parigi.')) a.storage.aggiungiMessaggio({ conversazione: highId, ...m });
    const c = cls('Tornando all ibuprofene, posso aumentarlo?', a.storage.messaggi(highId, 40));
    assert.equal(c.riferimento.stato, 'assente'); assert.equal(c.ambigua, true);
  } finally { a.storage.chiudi(); }
});

test('B0005: MODEL_NOT_FOUND, retry ed escalation high non degradano a Haiku', async () => {
  for (const modo of ['assente', 'retry', 'escalation']) {
    const a = crea({ produttore: ({ n }) => {
      if (n === 1 && modo !== 'escalation') throw new OrbitError(modo === 'assente' ? 'MODEL_NOT_FOUND' : 'SERVER', 'Errore sintetico', { retryable: true });
      return { text: 'Risposta sintetica italiana.' };
    }, verificatore: ({ n }) => modo === 'escalation' && n === 1 ? { status: 'FAIL', reason: 'Sintetico', failed_criteria: ['correttezza'] } : PASS }, { maxRetryApi: 1 });
    try {
      const { r } = await chiedi(a, HIGH);
      assert.equal(r.verifica, 'PASS'); assert.ok(a.provider.chiamate.every(c => !c.model.includes('haiku')));
      if (modo === 'escalation') assert.equal(r.escalation, 1);
      if (modo === 'assente') assert.deepEqual(a.provider.chiamate.map(c => c.model), ['mock-sonnet-1', 'mock-opus-1', 'mock-opus-1']);
      if (modo === 'retry') assert.equal(a.provider.conteggio('produttore'), 2);
    } finally { a.storage.chiudi(); }
  }
});

test('B0005: senza produttore o verificatore ammesso nessuna candidata high viene consegnata', async () => {
  for (const soloHaiku of [true, false]) {
    const a = crea(soloHaiku ? { modelli: [{ id: 'mock-haiku-1' }] } : { verificatore: () => { throw new OrbitError('MODEL_NOT_FOUND', 'Sintetico'); } });
    try {
      const { r, tipi } = await chiedi(a, HIGH);
      assert.equal(r.ok, false); assert.equal(r.testo, undefined); assert.equal(tipi.includes('finale'), false);
      assert.ok(a.provider.chiamate.every(c => !c.model.includes('haiku')));
      if (soloHaiku) assert.equal(a.provider.chiamate.length, 0);
    } finally { a.storage.chiudi(); }
  }
});

test('B0005: web prima del routing finale mantiene high e i modelli ammessi', async () => {
  const a = crea();
  try {
    a.permessi.impostaAbilitata('web', true);
    const richieste = [], chiama = a.gateway.chiama.bind(a.gateway);
    a.gateway.chiama = arg => { richieste.push(arg); return chiama(arg); };
    const { r } = await chiedi(a, 'Cerca sul web quanto ibuprofene posso prendere.');
    assert.equal(r.verifica, 'PASS');
    const web = richieste.filter(c => c.ruolo === 'strumento_web');
    assert.ok(web.length > 0); assert.ok(web.every(c => c.run.piano.rischio === 'high'));
    assert.ok(a.provider.chiamate.every(c => !c.model.includes('haiku')));
  } finally { a.storage.chiudi(); }
});

test('B0005: low e aritmetica certificata conservano numero di chiamate e zero retrieval', async () => {
  const a = crea();
  try {
    assert.equal((await chiedi(a, 'come va?')).r.piano.rischio, 'low');
    assert.equal(a.provider.chiamate.length, 1);
    assert.equal((await chiedi(a, 'Traduci in inglese: buongiorno a tutti')).r.piano.rischio, 'low');
    assert.equal(a.provider.chiamate.length, 2);
    a.orchestrator.memoria = { cerca() { throw new Error('Retrieval inatteso'); } };
    const { r } = await chiedi(a, 'Quanto fa 7 per 8?');
    assert.equal(r.testo, '56.'); assert.equal(r.chiamateAI, 0); assert.equal(a.provider.chiamate.length, 2);
  } finally { a.storage.chiudi(); }
});

test('B0005 P1: domande si-no operative non dipendono dalle vecchie parole interrogative', () => {
  for (const q of ['È sicuro assumere ibuprofene?', 'È sicuro assumere ibuprofene',
    'Sarebbe prudente prendere paracetamolo', 'Assumo due compresse?',
    'Ripartisco i risparmi tra ETF e BTC?']) {
    assert.equal(cls(q).rischio, 'high', q);
  }
});

test('B0005 P1: anafore operative promosse da antecedente informativo low indipendente', () => {
  const storia = coppia('Che cos’è ibuprofene?', 'Un principio attivo.');
  assert.equal(cls(storia[0].contenuto).rischio, 'low');
  assert.equal(rilevaRischio(storia[1].contenuto).rischio, 'low');
  for (const q of ['Ne prendo una?', 'Lo prendo?', 'La assumo?', 'È sicuro prenderlo?', 'Sarebbe prudente assumerlo']) {
    const c = cls(q, storia);
    assert.equal(c.riferimento.stato, 'chiaro', q); assert.equal(c.riferimento.indice, 0);
    assert.equal(c.rischio, 'high', q); assert.equal(c.ambigua, false);
  }
  const finanza = coppia('Che cos’è Bitcoin?', 'Una valuta digitale.');
  assert.equal(cls(finanza[0].contenuto).rischio, 'low');
  assert.equal(cls('Ne compro un po’?', finanza).rischio, 'high');
});

test('B0005 P1: domande generiche, citazioni e domini non operativi non diventano high', () => {
  for (const q of ['È sicuro il file ibuprofene.txt?', 'La pillola appare nel film?', 'Bitcoin è una parola inglese?',
    'Esistono ETF?', 'Traduci: "È sicuro assumere ibuprofene?"', 'Correggi: «Ne prendo una?»']) {
    assert.equal(cls(q).rischio, 'low', q);
  }
  for (const q of ['Riassumilo', 'Cambiamo argomento: ne prendo una?', 'Qual è la capitale della Francia?']) {
    assert.equal(cls(q, coppia('Che cos’è ibuprofene?', 'Un principio attivo.')).rischio, 'low', q);
  }
  assert.equal(cls('Ne prendo una?', coppia('Offrimi una caramella', 'Una caramella alla menta.')).rischio, 'low');
});

test('B0005 P1: flusso completo da menzione low a domanda operativa verifica con Sonnet', async () => {
  const a = crea({ produttore: ({ n }) => ({ text: n === 1 ? 'Un principio attivo.' : 'Risposta sintetica italiana.' }) });
  try {
    const primo = (await chiedi(a, 'Che cos’è ibuprofene?')).r;
    assert.equal(primo.piano.rischio, 'low'); assert.equal(a.provider.chiamate.length, 1);
    const { r, eventi } = await chiedi(a, 'Ne prendo una?', { conversazioneId: primo.conversazioneId });
    assert.equal(eventi.find(e => e.tipo === 'classificata').rischio, 'high');
    assert.equal(r.piano.rischio, 'high'); assert.equal(r.piano.verifica.modo, 'semantico'); assert.equal(r.verifica, 'PASS');
    assert.deepEqual(a.provider.chiamate.slice(1).map(c => [c.ruolo, c.model]), [
      ['produttore', 'mock-sonnet-1'], ['verificatore', 'mock-sonnet-1']]);
    const prompt = costruisciPrompt(a.provider.chiamate[1]);
    assert.match(prompt, /Che cos’è ibuprofene/); assert.match(prompt, /Un principio attivo\./); assert.match(prompt, /Ne prendo una/);
  } finally { a.storage.chiudi(); }
});

test('B0005 P1: domanda si-no diretta e anafora low iniziale rispettano B0006 senza modelli ammessi', async () => {
  for (const anafora of [false, true]) {
    const a = crea({ modelli: [{ id: 'mock-haiku-1' }] });
    try {
      const id = salva(a, anafora ? coppia('Che cos’è ibuprofene?', 'Un principio attivo.') : []);
      const { r, tipi } = await chiedi(a, anafora ? 'Ne prendo una?' : 'È sicuro assumere ibuprofene?', { conversazioneId: id });
      assert.equal(r.codice, 'NO_MODEL'); assert.equal(r.ok, false); assert.equal(r.testo, undefined);
      assert.equal(a.provider.chiamate.length, 0); assert.equal(tipi.includes('finale'), false);
    } finally { a.storage.chiudi(); }
  }
});

test('B0005 P1: si-no high nel flusso completo, indisponibilita e verificatore ammesso', async () => {
  const a = crea({ produttore: ({ model }) => {
    if (model.includes('sonnet')) throw new OrbitError('MODEL_NOT_FOUND', 'Sintetico', { retryable: true });
    return { text: 'Risposta sintetica italiana.' };
  } });
  try {
    const { r } = await chiedi(a, 'È sicuro assumere ibuprofene?');
    assert.equal(r.verifica, 'PASS'); assert.equal(r.piano.rischio, 'high');
    assert.deepEqual(a.provider.chiamate.map(c => [c.ruolo, c.model]), [
      ['produttore', 'mock-sonnet-1'], ['produttore', 'mock-opus-1'], ['verificatore', 'mock-opus-1']]);
  } finally { a.storage.chiudi(); }
});

test('B0005 P1: nuove anafore assenti o ambigue fermano il flusso, chat separate non ereditano dominio', async () => {
  const a = crea();
  try {
    salva(a, coppia('Che cos’è ibuprofene?', 'Un principio attivo.'));
    assert.equal((await chiedi(a, 'Ne prendo una?')).r.verifica, 'CHIARIMENTO');
    const ambiguo = salva(a, coppia('Descrivi ibuprofene oppure paracetamolo', 'Due principi attivi.'));
    assert.equal((await chiedi(a, 'Ne prendo una?', { conversazioneId: ambiguo })).r.verifica, 'CHIARIMENTO');
    assert.equal(a.provider.chiamate.length, 0);
    const low = salva(a, coppia('Offrimi una caramella', 'Una caramella alla menta.'));
    const { r } = await chiedi(a, 'Ne prendo una?', { conversazioneId: low });
    assert.equal(r.piano.rischio, 'low'); assert.equal(a.provider.chiamate.length, 1);
    assert.doesNotMatch(costruisciPrompt(a.provider.chiamate[0]), /ibuprofene|paracetamolo/);
  } finally { a.storage.chiudi(); }
});

for (const q of ['Ne prendo una o due', 'Ne assumo una', 'Lo prendo', 'La assumo', 'Aumentarlo']) {
  test('B0005 P1 residuo: intento risolto senza punteggiatura nel flusso completo: ' + q, async () => {
    const a = crea({ produttore: ({ n }) => ({ text: n === 1 ? 'Un principio attivo.' : 'Risposta sintetica italiana.' }) });
    try {
      const primo = (await chiedi(a, 'Che cos’è ibuprofene?')).r;
      assert.equal(primo.piano.rischio, 'low'); assert.equal(a.provider.chiamate.length, 1);
      const c = cls(q, a.storage.messaggi(primo.conversazioneId));
      assert.equal(c.riferimento.stato, 'chiaro'); assert.equal(c.riferimento.operativa, true);
      assert.equal(c.rischio, 'high'); assert.equal(c.ambigua, false);
      const { r, eventi } = await chiedi(a, q, { conversazioneId: primo.conversazioneId });
      assert.equal(eventi.find(e => e.tipo === 'classificata').rischio, 'high');
      assert.equal(r.piano.rischio, 'high'); assert.equal(r.piano.verifica.modo, 'semantico'); assert.equal(r.verifica, 'PASS');
      assert.deepEqual(a.provider.chiamate.slice(1).map(c => [c.ruolo, c.model]), [
        ['produttore', 'mock-sonnet-1'], ['verificatore', 'mock-sonnet-1']]);
      assert.match(costruisciPrompt(a.provider.chiamate[1]), /Che cos’è ibuprofene/);
      assert.match(costruisciPrompt(a.provider.chiamate[1]), /Un principio attivo\./);
    } finally { a.storage.chiudi(); }
  });
}

test('B0005 P1 residuo: stessa anafora senza punteggiatura su caramella resta low nel flusso', async () => {
  const a = crea({ produttore: ({ n }) => ({ text: n === 1 ? 'Una caramella alla menta.' : 'Risposta sintetica italiana.' }) });
  try {
    const primo = (await chiedi(a, 'Offrimi una caramella')).r;
    assert.equal(primo.piano.rischio, 'low'); assert.equal(a.provider.chiamate.length, 1);
    const { r } = await chiedi(a, 'Ne prendo una o due', { conversazioneId: primo.conversazioneId });
    assert.equal(r.piano.rischio, 'low'); assert.equal(r.piano.verifica.modo, 'deterministico');
    assert.equal(a.provider.chiamate.length, 2); assert.ok(a.provider.chiamate.every(c => c.model === 'mock-haiku-1'));
  } finally { a.storage.chiudi(); }
});

test('B0005 P1 residuo: intento operativo non si inventa per assenza, ambiguita o trasformazioni', async () => {
  const q = 'Ne prendo una o due', menzione = coppia('Che cos’è ibuprofene?', 'Un principio attivo.');
  for (const storia of [[], coppia('Descrivi ibuprofene oppure paracetamolo', 'Due principi attivi.')]) {
    const c = cls(q, storia);
    assert.equal(c.ambigua, true); assert.notEqual(c.riferimento.operativa, true);
  }
  for (const testo of ['Riassumilo', 'Cambiamo argomento: ne prendo una o due', 'Traduci: "Ne prendo una o due"']) {
    const c = cls(testo, menzione);
    assert.equal(c.rischio, 'low'); assert.notEqual(c.riferimento.operativa, true);
  }
  const a = crea();
  try {
    const id = salva(a, coppia('Che cos’è ibuprofene?', 'Contesto sintetico '.repeat(3000)));
    assert.equal((await chiedi(a, q, { conversazioneId: id })).r.verifica, 'CHIARIMENTO');
    assert.equal((await chiedi(a, q)).r.verifica, 'CHIARIMENTO');
    const ambiguo = salva(a, coppia('Descrivi ibuprofene oppure paracetamolo', 'Due principi attivi.'));
    assert.equal((await chiedi(a, q, { conversazioneId: ambiguo })).r.verifica, 'CHIARIMENTO');
    assert.equal(a.provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});

test('B0005 P1 residuo: senza punteggiatura non degrada con solo Haiku disponibile', async () => {
  const a = crea({ modelli: [{ id: 'mock-haiku-1' }] });
  try {
    const id = salva(a, coppia('Che cos’è ibuprofene?', 'Un principio attivo.'));
    const { r, tipi } = await chiedi(a, 'Ne prendo una o due', { conversazioneId: id });
    assert.equal(r.codice, 'NO_MODEL'); assert.equal(r.ok, false); assert.equal(r.testo, undefined);
    assert.equal(a.provider.chiamate.length, 0); assert.equal(tipi.includes('finale'), false);
  } finally { a.storage.chiudi(); }
});
