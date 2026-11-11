'use strict';
// Controlli deterministici del Quality Gate: codice locale, nessuna chiamata AI.
const vm = require('vm');
const { valuta, risultatoPresente } = require('./aritmetica');

const PAROLE_IT = new Set('il lo la i gli le un una di del della dei delle che non per con sono come anche questo questa nel nella piu più ma se si e è ha hanno essere quando dove perché perche quindi allora cio ciò puoi posso devi molto tutto'.split(' '));
const PAROLE_EN = new Set('the of and to in is are was were that this with for on as be by it not you your from have has can will would which what when where because then there their about'.split(' '));

function conteggioLingua(testo) {
  const parole = (testo.toLowerCase().match(/[\p{L}']+/gu) || []);
  let it = 0, en = 0;
  for (const p of parole) { if (PAROLE_IT.has(p)) it++; if (PAROLE_EN.has(p)) en++; }
  return { parole: parole.length, it, en };
}

function estraiJson(testo) {
  const t = testo.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) { return undefined; }
}

// Percorsi di note (file .md) citati nel testo.
function percorsiCitati(testo) {
  const trovati = new Set();
  for (const m of testo.matchAll(/[\p{L}\p{N}_\-./]*[\p{L}\p{N}_\-]\.md\b/gu)) trovati.add(m[0].replace(/^\.\//, ''));
  return [...trovati];
}

// Controllo di SINTASSI dei blocchi di codice JavaScript e JSON: si compila senza eseguire nulla (vm.Script non lancia il codice).
// Gli altri linguaggi non si possono verificare in locale: restano a carico del verificatore AI, senza dichiarare correttezza.
function erroriSintassi(testo) {
  const errori = [];
  for (const m of testo.matchAll(/```(\w+)?[^\n]*\n([\s\S]*?)```/g)) {
    const lingua = (m[1] || '').toLowerCase(), codice = m[2];
    if (lingua === 'json') { try { JSON.parse(codice); } catch (e) { errori.push('JSON non valido: ' + e.message.slice(0, 80)); } }
    else if (['js', 'javascript', 'node'].includes(lingua) && !/^\s*(import|export)\s/m.test(codice)) {
      try { new vm.Script(codice, { filename: 'blocco.js' }); } catch (e) { errori.push('JavaScript con errore di sintassi: ' + String(e.message).slice(0, 80)); }
    }
  }
  return errori;
}

// Frasi che rimandano all'utente una lettura (web, calendario, posta, file). Due tipi diversi:
//  - INVITO A RIFORMULARE ("prova a scrivere...", "chiedimelo con quelle parole"): sempre un errore se gli strumenti c'erano;
//  - OFFERTA ("vuoi che cerchi online?", "se vuoi controllo il calendario"): e un errore SOLO se riguarda una lettura che la richiesta
//    originale chiedeva e che nel turno non e stata eseguita; se la richiesta e stata soddisfatta, un'offerta in piu e legittima.
const RE_RIFORMULA = /(prova a (?:scrivere|chiedere|chiedermi|dire|dirmi)|chiedimel[oai]|chiedimi (?:di |con |pure |esplicitamente)|scrivi(?:mi)? (?:pure )?(?:qualcosa come |una frase come )?["«“]|riformula|ripeti la (?:domanda|richiesta)|con (?:quelle|queste|le) parole|solo se me lo chiedi|se me lo chiedi|lo faccio solo se|basta che (?:tu )?(?:mi )?(?:scriva|chieda|dica))/i;
const RE_OFFERTA = /(vuoi che (?:lo |la |li |le |ti )?(?:cerchi|controlli|guardi|verifichi|legga|riprov\w*)|se vuoi(?:,)? (?:posso |ti )?(?:cercar\w*|controllar\w*|guardar\w*|verificar\w*|legger\w*|riprov\w*)|posso (?:anche )?(?:cercar\w*|controllar\w*|guardar\w*|verificar\w*)(?: [^.?!]{0,40})? se (?:vuoi|ti serve))/i;
const RE_LETTURA = /(cerc\w*|online|on line|web|internet|calendari\w*|event\w*|impegn\w*|mail|posta|file|document\w*|partit\w*|risultat\w*)/i;
const RE_SCRITTURA = /(salv\w*|aggiung\w*|annot\w*|registr\w*|memorizz\w*|ricord\w*|nelle (?:tue )?note|nel (?:tuo )?cervello|nel vault|crea(?:re)? (?:una )?nota)/i;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Strumento a cui si riferisce una frase, e se la richiesta originale lo chiedeva davvero.
function dominio(frase) {
  const f = norm(frase);
  if (/calendari|impegn|event[io]|agenda|appuntament/.test(f)) return 'google.elenca_eventi';
  if (/\bmail|posta|gmail/.test(f)) return 'google.cerca_mail';
  if (/\bfile|document/.test(f)) return 'documenti.';
  if (/cerc|online|on line|web|internet|ricerca/.test(f)) return 'web.cerca_web';
  return null;
}
function richiestaChiede(richiesta, dom) {
  const r = norm(richiesta);
  if (dom === 'google.elenca_eventi') return /\b(impegn\w*|agenda|appuntament\w*|eventi|sono libero|ho tempo|cosa ho|che cosa ho|mio calendario|nel calendario|lezion\w*)\b/.test(r);
  if (dom === 'google.cerca_mail') return /\b(mail|email|posta|gmail)\b/.test(r);
  if (dom === 'documenti.') return /\b(file|document\w*|pdf|cartell\w*|dispens\w*)\b/.test(r);
  if (dom === 'web.cerca_web') {
    const { richiestaPubblica } = require('../router/strumenti');
    return richiestaPubblica(richiesta) || (/\b(adesso|attual\w*|aggiornat\w*|ultim[ieao]|prossim\w*|prezz\w*|costa|quotazion\w*|notizi\w*|novita|oggi|online|internet|web)\b/.test(r) && !/\b(mio|mia|miei|mie|nelle mie note|vault)\b/.test(r));
  }
  return false;
}
// stato: { eseguitiOk: [nomi degli strumenti riusciti nel turno] }. Restituisce la frase che rimanda, oppure null.
function rimandaLettura(testo, { richiesta = null, stato = null } = {}) {
  const frasi = String(testo || '').split(/(?<=[.!?\n])\s+/);
  for (const f of frasi) {
    if (!RE_LETTURA.test(f) || RE_SCRITTURA.test(f)) continue;
    if (RE_RIFORMULA.test(f)) return f.trim();
    if (!RE_OFFERTA.test(f)) continue;
    if (richiesta === null) return f.trim();                                   // senza contesto (uso diretto): offerta sospetta
    const dom = dominio(f);
    const fatto = !!dom && (stato && stato.eseguitiOk || []).some(n => n.startsWith(dom));
    if (dom && !fatto && richiestaChiede(richiesta, dom)) return f.trim();       // offre invece di fare cio che era stato chiesto
  }
  return null;
}

// input: { testo, stopReason, piano, fonti: [percorsi], richiesta }
function controlla({ testo, stopReason, piano, fonti = [], richiesta = '' }) {
  const eseguiti = [], falliti = [];
  const nome = piano.verifica.controlli;
  const esegui = (id, ok, motivo, correzione) => { eseguiti.push(id); if (!ok) falliti.push({ id, motivo, correzione }); };

  if (nome.includes('non_vuota')) esegui('non_vuota', testo.trim().length > 0, 'La risposta e vuota.', 'Fornisci una risposta completa alla richiesta.');
  if (nome.includes('non_troncata')) esegui('non_troncata', stopReason !== 'max_tokens', 'La risposta e stata interrotta per limite di lunghezza.', 'Rispondi in modo piu conciso, in modo che la risposta sia completa.');

  if (nome.includes('lingua') && testo.trim()) {
    const chiedeAltraLingua = /\b(in inglese|in english|in francese|in spagnolo|in tedesco|translate|traduc\w*)\b/i.test(richiesta);
    const l = conteggioLingua(testo);
    if (!chiedeAltraLingua && l.parole >= 15 && piano.categoria !== 'code') {
      esegui('lingua', !(l.en >= 4 && l.en > l.it * 2), 'La risposta non e in italiano.', 'Riscrivi la risposta in italiano.');
    }
  }

  if (nome.includes('fonti_citate')) {
    const citati = percorsiCitati(testo);
    const inventati = citati.filter(c => !fonti.some(f => f === c || (f.endsWith(c) && /[/ ]/.test(f[f.length - c.length - 1])) || c.endsWith('/' + f)));
    esegui('fonti_citate', inventati.length === 0, 'Cita note che non sono tra quelle fornite: ' + inventati.join(', ') + '.',
      'Cita solo le note effettivamente fornite (' + (fonti.join(', ') || 'nessuna') + ') e non inventare percorsi.');
  }

  // Risposta che rimanda all'utente una LETTURA che Orbit poteva fare ("chiedimelo con queste parole", "vuoi che cerchi online?").
  // Solo se il modello aveva strumenti di lettura disponibili e nessuno e fallito (dire "la ricerca non e riuscita" e corretto);
  // le proposte di SCRIVERE (salvare una nota) restano legittime, perche richiedono la richiesta dell'utente.
  if (nome.includes('non_rimanda')) {
    const s = piano.verifica.strumenti || {};
    const frase = rimandaLettura(testo, { richiesta, stato: s });
    esegui('non_rimanda', !(frase && (s.disponibili || []).length && !s.errori),
      'La risposta rimanda all\'utente un\'operazione di lettura che Orbit poteva fare da solo: "' + (frase || '').slice(0, 120) + '".',
      'Non chiedere all\'utente di riformulare o di autorizzare una lettura: se ti servono dati, chiedi lo strumento con un blocco <orbit_strumento nome="...">{...}</orbit_strumento> (disponibili: ' + (s.disponibili || []).join(', ') + ') e poi rispondi con i risultati.');
  }

  if (nome.includes('calcolo') && piano.espressione) {
    const atteso = valuta(piano.espressione);
    esegui('calcolo', atteso != null && risultatoPresente(testo, atteso),
      'Il risultato di ' + piano.espressione + ' non compare nella risposta (valore corretto calcolato in locale: ' + atteso + ').',
      'Il risultato corretto di ' + piano.espressione + ' e ' + atteso + '. Riporta il calcolo e questo risultato.');
  }

  if (nome.includes('sintassi_codice')) {
    const es = erroriSintassi(testo);
    esegui('sintassi_codice', es.length === 0, es.join('; '), 'Correggi gli errori di sintassi del codice: ' + es.join('; ') + '.');
  }

  if (nome.includes('json')) {
    esegui('json', estraiJson(testo) !== undefined, 'L\'output non e JSON valido.', 'Restituisci solo JSON valido.');
  }

  return { esito: falliti.length ? 'FAIL' : 'PASS', eseguiti, falliti };
}

module.exports = { erroriSintassi, controlla, percorsiCitati, estraiJson, conteggioLingua, rimandaLettura };
