'use strict';
// Strumenti richiesti dal modello (correzione di un audit interno, non pubblicato). Il percorso veloce resta il pianificatore deterministico
// (strumenti.js); questo serve quando il modello capisce che gli manca un dato che solo uno strumento di LETTURA puo dare.
// Stesso schema dei blocchi gia usati da Orbit (<orbit_nota>, <orbit_ricorda>): il modello scrive
//   <orbit_strumento nome="web.cerca_web">{"domanda": "prossime partite dei Celtics"}</orbit_strumento>
// e l'orchestratore, dopo averlo validato, lo esegue SEMPRE tramite IntegrationManager (abilitazione, permessi, audit, timeout).
// Regole: solo strumenti di livello "lettura" delle integrazioni abilitate; nome e parametri validati sullo schema dello strumento;
// al massimo 3 richieste per giro e 2 giri per richiesta (li conta l'orchestratore); niente blocchi malformati o strumenti arbitrari.
const { valida } = require('../../integrations/registry');

const MAX_PER_GIRO = 3;
const RE_BLOCCO = /<orbit_strumento\b([^>]*)>([\s\S]*?)<\/orbit_strumento>/g;
const RE_APERTO = /<orbit_strumento\b/g;
const RE_NOME = /^\s*nome\s*=\s*"([a-z]+\.[a-z_]+)"\s*$/;

// Note su come usare i parametri, per i modelli piccoli (il resto viene dallo schema).
const SUGGERIMENTI = {
  'web.cerca_web': 'web, dati pubblici aggiornati (sport, risultati, notizie, orari, prezzi, meteo); domanda completa in italiano',
  'google.elenca_eventi': 'calendario Google dell\'utente; date AAAA-MM-GG, massimo 62 giorni',
  'google.cerca_mail': 'posta Gmail dell\'utente',
  'google.leggi_mail': 'testo di una mail trovata con cerca_mail',
  'documenti.cerca_file': 'file per nome nelle cartelle autorizzate',
  'documenti.cerca_contenuto': 'testo dentro i file delle cartelle autorizzate',
  'documenti.leggi_documento': 'legge un file (per i PDF indica le pagine)',
  'obsidian.cerca_note': 'note del vault dell\'utente',
  'obsidian.leggi_nota': 'legge una nota del vault (sezione o query: solo le parti utili)'
};
// Strumenti di lettura poco utili da chiedere al modello (servono all'interfaccia o hanno un equivalente sopra): fuori dal catalogo, meno token.
const ESCLUSI = new Set(['google.leggi_conversazione', 'documenti.elenca_cartella', 'obsidian.elenca_note']);

// Strumenti che il modello puo chiedere: solo lettura, solo integrazioni abilitate.
function catalogo(integrazioni) {
  if (!integrazioni) return [];
  const out = [];
  for (const [id, integr] of integrazioni.integrazioni) {
    if (!integrazioni.permessi.stato(id).abilitata) continue;
    for (const [nome, st] of Object.entries(integr.strumenti || {})) {
      if (st.livello !== 'lettura' || ESCLUSI.has(id + '.' + nome)) continue;
      const campi = Object.entries(st.schema || {}).map(([k, v]) => ({ nome: k, tipo: v.tipo, richiesto: !!v.richiesto }));
      out.push({ nome: id + '.' + nome, integrazione: id, strumento: nome, descrizione: SUGGERIMENTI[id + '.' + nome] || String(st.descrizione || '').slice(0, 70), campi, schema: st.schema || {} });
    }
  }
  return out;
}

function testoCatalogo(cat, oggi) {
  if (!cat.length) return '';
  // Per contenere i token: i campi obbligatori e al massimo 3 facoltativi per strumento, descrizioni brevi.
  const righe = cat.map(c => {
    const campi = c.campi.filter(f => f.richiesto).concat(c.campi.filter(f => !f.richiesto).slice(0, 3));
    return '- ' + c.nome + ' {' + campi.map(f => f.nome + (f.richiesto ? '' : '?')).join(', ') + '}: ' + c.descrizione.replace(/\.$/, '');
  });
  return '<strumenti_disponibili>\nOggi e ' + oggi + '. Se per rispondere bene ti serve un dato che NON e gia nel contesto qui sotto (informazioni pubbliche aggiornate, ' +
    'impegni del calendario, mail, file, note), NON chiedere all\'utente di riformulare: rispondi SOLO con uno o piu blocchi (massimo ' + MAX_PER_GIRO + '), senza altro testo, ' +
    'e Orbit ti richiamera con i risultati. Formato esatto, parametri in JSON:\n<orbit_strumento nome="web.cerca_web">{"domanda": "..."}</orbit_strumento>\n' +
    'Strumenti (tutti in sola lettura):\n' + righe.join('\n') + '\n' +
    'Usali solo se servono davvero: non per saluti, calcoli o conoscenze generali che non cambiano. Non ripetere uno strumento gia eseguito con gli stessi parametri. ' +
    'Per richieste miste usa piu strumenti (per esempio prima il web, poi il calendario nelle date trovate). Se uno strumento fallisce, dillo senza inventare i dati. ' +
    'Non esistono strumenti per scrivere, cancellare o inviare: se l\'utente lo chiede, spiega che serve la sua conferma o che Orbit non puo farlo.\n</strumenti_disponibili>';
}

// Chiave per riconoscere la stessa chiamata con parametri equivalenti (spazi, maiuscole, ordine dei campi).
function chiave(nome, params) {
  const norm = v => (typeof v === 'string' ? v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}:\/.-]+/gu, ' ').trim() : Array.isArray(v) ? v.map(norm) : v);
  return nome + ' ' + JSON.stringify(Object.keys(params || {}).sort().reduce((o, k) => { if (params[k] !== undefined && params[k] !== null && params[k] !== '') o[k] = norm(params[k]); return o; }, {}));
}

// Estrae e VALIDA le richieste dal testo del modello. Restituisce { presenti, richieste, invalide, testo } (testo senza blocchi).
function estraiRichieste(testoModello, cat) {
  const s = String(testoModello || '');
  const aperti = (s.match(RE_APERTO) || []).length;
  const richieste = [], invalide = [];
  let chiusi = 0;
  const testo = s.replace(RE_BLOCCO, (tutto, attr, corpo) => {
    chiusi++;
    if (richieste.length + invalide.length >= MAX_PER_GIRO) { invalide.push({ grezzo: tutto.slice(0, 120), motivo: 'troppe richieste nello stesso giro (massimo ' + MAX_PER_GIRO + ')' }); return ''; }
    const m = attr.match(RE_NOME);
    if (!m) { invalide.push({ grezzo: tutto.slice(0, 120), motivo: 'attributo nome mancante o non valido' }); return ''; }
    const voce = cat.find(c => c.nome === m[1]);
    if (!voce) { invalide.push({ nome: m[1], grezzo: tutto.slice(0, 120), motivo: 'strumento non disponibile o non consentito (sono ammessi solo strumenti di lettura abilitati)' }); return ''; }
    let params;
    const c = corpo.trim();
    try { params = c ? JSON.parse(c) : {}; } catch (e) { invalide.push({ nome: voce.nome, grezzo: tutto.slice(0, 120), motivo: 'parametri non in JSON valido' }); return ''; }
    if (!params || typeof params !== 'object' || Array.isArray(params)) { invalide.push({ nome: voce.nome, grezzo: tutto.slice(0, 120), motivo: 'i parametri devono essere un oggetto JSON' }); return ''; }
    const ignoti = Object.keys(params).filter(k => !(k in voce.schema));
    if (ignoti.length) { invalide.push({ nome: voce.nome, grezzo: tutto.slice(0, 120), motivo: 'parametri sconosciuti: ' + ignoti.join(', ') }); return ''; }
    const v = valida(voce.schema, params);
    if (!v.ok) { invalide.push({ nome: voce.nome, grezzo: tutto.slice(0, 120), motivo: v.errore }); return ''; }
    richieste.push({ nome: voce.nome, integrazione: voce.integrazione, strumento: voce.strumento, params: v.valori || params });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  if (aperti > chiusi) invalide.push({ grezzo: '<orbit_strumento ...', motivo: 'blocco non chiuso correttamente' });
  return { presenti: aperti > 0, richieste, invalide, testo: testo.replace(/<orbit_strumento\b[\s\S]*$/, '').trim() };
}

module.exports = { catalogo, testoCatalogo, estraiRichieste, chiave, MAX_PER_GIRO };
