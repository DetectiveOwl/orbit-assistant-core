'use strict';
const { nomeUtente } = require('./profilo');
// Livello di accesso alla memoria di Orbit. Il vault Obsidian e la fonte di verita,
// questo modulo lo legge soltanto: non esiste nessuna funzione che scriva, sposti o cancelli note.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Indice } = require('./indice');
const ricerca = require('./ricerca');
const { sezioniNota } = require('./analisi');

const indice = new Indice();
let statoVault = { ok: false, errore: 'Memoria non ancora avviata.' };
let motoreRegistrato = false;

// Verifica il vault e aggiorna l'indice. Non lancia eccezioni: se qualcosa non va,
// la chat continua a funzionare e lo stato contiene un errore leggibile.
function avvia() {
  statoVault = config.verificaVault();
  if (!statoVault.ok) return stato();
  try {
    indice.apri();
    if (!motoreRegistrato) { ricerca.registraMotore('testuale', ricerca.creaMotoreTestuale(indice)); motoreRegistrato = true; }
    indice.sincronizza({ forza: true });
  } catch (e) {
    statoVault = { ok: false, errore: 'Non riesco a preparare l\'indice delle note: ' + e.message };
  }
  return stato();
}

function stato() {
  const base = { ok: statoVault.ok, errore: statoVault.errore, vault: config.vaultPath, fileIndice: config.indexFile };
  if (!statoVault.ok || !indice.db) return base;
  try { return Object.assign(base, indice.stato()); } catch (e) { return base; }
}

// Stato aggiornato per l'interfaccia: se il vault e tornato disponibile riavvia la memoria,
// se e sparito lo segnala.
function controlla() {
  const v = config.verificaVault();
  if (!v.ok) { statoVault = v; return stato(); }
  if (!statoVault.ok || !indice.db) return avvia();
  try { indice.sincronizza(); } catch (e) { /* lo stato resta quello precedente */ }
  return stato();
}

// Ogni operazione ricontrolla il vault (puo sparire, ad esempio un disco scollegato) e aggiorna l'indice in modo incrementale.
function pronto() {
  const v = config.verificaVault();
  if (!v.ok) { statoVault = v; throw new Error(v.errore); }
  if (!statoVault.ok || !indice.db) avvia();
  if (!statoVault.ok) throw new Error(statoVault.errore);
  indice.sincronizza();
}

// Avviso di modifica (lo chiama chi ha appena scritto nel vault, cioe l'integrazione Obsidian di Orbit): aggiorna SOLO le note
// indicate, cosi la domanda successiva le vede subito, anche entro l'intervallo minimo tra due scansioni. La memoria resta in sola lettura.
function notificaModifica(percorsi = []) {
  if (!statoVault.ok || !indice.db) return { aggiornate: 0 };
  let aggiornate = 0;
  for (const p of [].concat(percorsi)) {
    try { if (indice.aggiornaFile(p).esito !== 'invariata') aggiornate++; }
    catch (e) { try { indice.sincronizza({ forza: true }); } catch (x) { /* si riprova alla prossima richiesta */ } }
  }
  return { aggiornate };
}

function cerca(query, opzioni = {}) {
  pronto();
  return ricerca.motore(opzioni.motore).cerca(query, opzioni);
}

// Ricerca unica per gli strumenti (server MCP, integrazione Obsidian, CLI): stesso retrieval per sezioni della chat (passi 1-3,
// soglia di pertinenza, sigle, cache con controllo di freschezza), raggruppato per nota con la sezione migliore e un estratto.
// Le query con filtri di tag (tag:nome, #nome) usano la ricerca per note, l'unica che conosce i tag; i risultati hanno gli stessi campi.
function cercaNote(query, { limite = 8, cartella = null } = {}) {
  pronto();
  const q = ricerca.analizzaQuery(query, { cartella });
  const max = Math.max(1, Math.min(Number(limite) || 8, 20));
  if (q.tag.length) return ricerca.motore().cerca(query, { limite: max, cartella });
  const r = ricerca.motore().cercaSezioni(query, { limite: 8, cartella });
  const dentro = p => !q.cartella || p === q.cartella || p.startsWith(q.cartella + '/');
  const perNota = new Map();
  for (const s of (r.sezioni || []).concat(cartella || q.cartella ? (r.altri || []).filter(x => x.pertinenza >= ricerca.SOGLIA_ASSOLUTA) : [])) {
    if (!dentro(s.percorso) || perNota.has(s.percorso)) continue;
    const e = estrattoSezione(s.testo, r.radici).testo.replace(/\s+/g, ' ').trim();
    const riga = indice.db.prepare('SELECT tag FROM note WHERE percorso = ?').get(s.percorso);
    perNota.set(s.percorso, { percorso: s.percorso, titolo: s.titoloNota, sezione: s.sezione || null, punteggio: s.pertinenza, estratto: e.length > 400 ? e.slice(0, 400) + '...' : e, tag: riga ? JSON.parse(riga.tag) : [], motore: 'sezioni' });
  }
  return [...perNota.values()].slice(0, max);
}

// Lettura mirata di una nota: solo la sezione indicata (titolo o percorso di intestazioni) oppure solo le sezioni che contengono
// le parole di `query`, con l'estrattore di righe per quelle lunghe. Senza sezione ne query la nota si legge intera con leggiNota.
function leggiSezioni(percorso, { sezione = null, query = null } = {}) {
  const n = leggiNota(percorso);
  const src = ricerca.leggiOriginale(n.percorso) || n.contenuto;
  const tutte = sezioniNota(src).map(s => ({ sezione: s.percorso || '(inizio della nota)', titolo: s.titolo || '', testo: src.slice(s.inizio, s.fine) }));
  let scelte = [], radici = [];
  if (sezione) {
    const cerca = ricerca.normalizza(String(sezione)).trim();
    scelte = tutte.filter(s => ricerca.normalizza(s.titolo).trim() === cerca || ricerca.normalizza(s.sezione).endsWith(cerca));
  } else if (query) {
    radici = ricerca.analizzaQuery(query).termini.map(ricerca.radice);
    scelte = tutte.filter(s => radici.some(t => ricerca.normalizza(s.sezione + ' ' + s.testo).includes(t)));
  }
  return {
    percorso: n.percorso, titolo: n.titolo, tag: n.tag, intera: false,
    sezioniDisponibili: tutte.map(s => s.sezione),
    // una sezione chiesta per nome arriva intera; con una query, le sezioni lunghe passano dall'estrattore di righe
    sezioni: scelte.map(s => { const e = radici.length ? estrattoSezione(s.testo, radici) : { testo: s.testo.replace(/\s+$/, ''), intera: true }; return { sezione: s.sezione, testo: e.testo, estratto: !e.intera }; })
  };
}

// Accetta solo percorsi relativi dentro il vault, fuori dalle cartelle tecniche.
function percorsoSicuro(percorso) {
  const rel = String(percorso || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(config.vaultPath, rel);
  const dentro = abs === config.vaultPath || abs.startsWith(config.vaultPath + path.sep);
  const pulito = path.relative(config.vaultPath, abs).split(path.sep).join('/');
  if (!dentro || !pulito || pulito.split('/').some(config.cartellaEsclusa)) return null;
  return { abs, rel: pulito };
}

function leggiNota(percorso) {
  pronto();
  let p = percorsoSicuro(percorso);
  if (p && !/\.md$/i.test(p.rel) && fs.existsSync(p.abs + '.md')) p = percorsoSicuro(p.rel + '.md');
  if (!p || !/\.md$/i.test(p.rel)) {
    const r = p && indice.risolviLink(p.rel);       // accetta anche un nome di nota come in un wikilink
    if (r && r.tipo === 'nota') p = percorsoSicuro(r.percorso);
    else throw new Error('Nota non trovata o fuori dal vault: ' + percorso);
  }
  let contenuto;
  try { contenuto = fs.readFileSync(p.abs, 'utf8'); } catch (e) { throw new Error('Nota non trovata: ' + p.rel); }
  const riga = indice.db.prepare('SELECT id, titolo, tag, frontmatter, intestazioni, mtime FROM note WHERE percorso = ?').get(p.rel);

  const uscenti = riga ? indice.db.prepare('SELECT destinazione, sezione, embed FROM link WHERE sorgente = ?').all(riga.id)
    .map(l => {
      const r = indice.risolviLink(l.destinazione, p.rel);
      return { link: l.destinazione + (l.sezione ? '#' + l.sezione : ''), embed: !!l.embed, risolto: r ? r.percorso : null, tipo: r ? r.tipo : 'mancante' };
    }) : [];
  const entranti = [];
  for (const l of indice.db.prepare('SELECT n.percorso, l.destinazione FROM link l JOIN note n ON n.id = l.sorgente').all()) {
    if (l.percorso === p.rel || entranti.includes(l.percorso)) continue;
    const r = indice.risolviLink(l.destinazione, l.percorso);
    if (r && r.percorso === p.rel) entranti.push(l.percorso);
  }
  return {
    percorso: p.rel,
    titolo: riga ? riga.titolo : path.basename(p.rel, '.md'),
    tag: riga ? JSON.parse(riga.tag) : [],
    frontmatter: riga ? JSON.parse(riga.frontmatter) : {},
    modificata: riga ? new Date(riga.mtime).toISOString() : null,
    linkUscenti: uscenti,
    backlink: entranti,
    contenuto
  };
}

function elencaNote({ cartella } = {}) {
  pronto();
  const c = cartella ? String(cartella).replace(/\\/g, '/').replace(/\/$/, '') : null;
  const note = indice.db.prepare('SELECT percorso, titolo, tag, parole FROM note ORDER BY percorso').all()
    .filter(n => !c || n.percorso === c || n.percorso.startsWith(c + '/'))
    .map(n => ({ percorso: n.percorso, titolo: n.titolo, tag: JSON.parse(n.tag), parole: n.parole }));
  const allegati = indice.db.prepare('SELECT percorso, estensione, dimensione FROM allegati ORDER BY percorso').all()
    .filter(a => !c || a.percorso.startsWith(c + '/'));
  return { note, allegati };
}

// Prepara il blocco di contesto da dare al modello per una domanda: le note piu pertinenti,
// lette dai file originali, con il loro percorso per poterle citare.
// escludi: note gia presenti nel contesto per altra via (per esempio il profilo): non si rimandano, ma si segnalano in `giaPresenti`
// cosi la provenienza resta tracciata e il budget va ad altre note pertinenti.
function contestoPerDomanda(domanda, opzioni = {}) {
  // Passo 2: si recuperano sezioni (e dentro le sezioni lunghe solo le righe utili), non note intere.
  // Fase B: la vecchia via per note intere non c'e piu; se la memoria non funziona lo si dice al modello, che non inventa.
  try {
    pronto();
    return contestoPerSezioni(domanda, opzioni);
  } catch (e) {
    console.error('Memoria: ricerca per sezioni non riuscita (' + e.message + ').');
    return { testo: '[Memoria di Orbit: il vault Obsidian non e disponibile (' + e.message + '). ' +
      'Dillo a ' + nomeUtente() + ' se la domanda riguarda i suoi appunti e non inventare il contenuto delle note.]', fonti: [], errore: e.message };
  }
}

const MAX_SEZIONE_INTERA = 1500;      // sotto questa lunghezza una sezione va intera; sopra si tengono le righe pertinenti
const MAX_SEZIONI_PER_NOTA = 3;

// Dentro una sezione lunga: righe di tabella e paragrafi che contengono termini della domanda, con l'intestazione della sezione
// e l'intestazione della tabella. Le parti omesse sono segnalate, non tolte in silenzio.
function estrattoSezione(testo, radici) {
  const t = testo.replace(/\s+$/, '');
  if (t.length <= MAX_SEZIONE_INTERA) return { testo: t, intera: true };
  const righe = t.split('\n');
  const unita = []; let cor = [];
  const chiudi = () => { if (cor.length) unita.push(cor); cor = []; };
  righe.forEach((r, i) => {
    if (i === 0 && /^\s{0,3}#/.test(r)) { chiudi(); unita.push([r]); return; }
    if (/^\s*\|/.test(r) || /^\s*\*\*[^*]+\*\*\s*$/.test(r)) { chiudi(); unita.push([r]); return; }   // righe di tabella e titoletti in grassetto
    if (!r.trim()) { chiudi(); return; }
    cor.push(r);
  });
  chiudi();
  const contiene = u => { const n = ricerca.normalizza(u.join(' ')); return radici.some(x => n.includes(x)); };
  const tieni = new Set();
  unita.forEach((u, i) => {
    if (i === 0 && /^\s{0,3}#/.test(u[0])) tieni.add(i);
    if (!contiene(u)) return;
    tieni.add(i);
    if (/^\s*\|/.test(u[0])) {           // riga di tabella: intestazione e separatore della tabella, e il titoletto che la precede
      let j = i; while (j > 0 && /^\s*\|/.test(unita[j - 1][0])) j--;
      tieni.add(j); if (j + 1 < i) tieni.add(j + 1);
      if (j > 0 && /^\s*\*\*/.test(unita[j - 1][0])) tieni.add(j - 1);
    }
  });
  // Nessuna riga contiene i termini (la sezione e stata scelta per il titolo): basta l'inizio, il resto e segnalato.
  if (tieni.size <= 1) return { testo: t.slice(0, 400).replace(/\s+\S*$/, '') + '\n[...sezione lunga: nessun\'altra riga contiene i termini della domanda]', intera: false };
  const out = []; let saltate = false;
  unita.forEach((u, i) => { if (tieni.has(i)) { if (saltate) out.push('[...]'); out.push(u.join('\n')); saltate = false; } else saltate = true; });
  if (saltate) out.push('[...]');
  return { testo: out.join('\n'), intera: false };
}

const MAX_ESPANSIONE = 3, BUDGET_ESPANSIONE = 4000;   // sezioni e caratteri aggiunti al massimo dall'espansione

// ampia: la domanda chiede una spiegazione, un quadro o piu parti (deciso dal classificatore sulla struttura della domanda).
function contestoPerSezioni(domanda, { limite = 4, maxCaratteri = 16000, escludi = [], ampia = false } = {}) {
  const r = ricerca.motore().cercaSezioni(domanda, { limite: 8 });
  const giaPresenti = [];
  const perNota = new Map();
  const aggiungi = (s, forza) => {
    if (escludi.includes(s.percorso)) { if (!giaPresenti.includes(s.percorso)) giaPresenti.push(s.percorso); return false; }
    if (!perNota.has(s.percorso)) { if (perNota.size >= limite + (forza ? 1 : 0)) return false; perNota.set(s.percorso, []); }
    const lista = perNota.get(s.percorso);
    if (lista.some(x => x.inizio === s.inizio) || lista.length >= MAX_SEZIONI_PER_NOTA + (forza ? 1 : 0)) return false;
    lista.push(s); return true;
  };
  for (const s of r.sezioni) aggiungi(s, false);
  // Espansione selettiva (passo 3): solo per domande ampie, partendo da cio che e gia stato scelto. Si aggiungono sezioni ancora
  // pertinenti che coprono un termine non ancora coperto o vengono da una nota diversa; ci si ferma al budget o quando non ce ne sono.
  let espanse = 0;
  if (ampia && (r.altri || []).length) {
    let extra = 0;
    const coperto = i => [...perNota.values()].flat().some(s => (s.copre || [])[i] >= 0.7);
    for (const s of r.altri) {
      if (espanse >= MAX_ESPANSIONE || extra >= BUDGET_ESPANSIONE) break;
      const nuovoTermine = (s.copre || []).some((c, i) => c >= 0.7 && !coperto(i));
      // una nota nuova entra solo se e pertinente quanto la soglia normale (le sezioni con un solo termine generico restano fuori)
      const nuovaNota = !perNota.has(s.percorso) && !escludi.includes(s.percorso) && s.pertinenza >= ricerca.SOGLIA_ASSOLUTA;
      if (!nuovoTermine && !nuovaNota) continue;
      const lunghezza = estrattoSezione(s.testo, r.radici).testo.length;
      if (extra + lunghezza > BUDGET_ESPANSIONE) continue;
      if (aggiungi(Object.assign({}, s, { espansione: true }), true)) { espanse++; extra += lunghezza; }
    }
  }
  const note = avvisiAssenze(r, perNota, escludi);
  if (!perNota.size) {
    return { testo: giaPresenti.length && !note ? '' : '[Memoria di Orbit: nessuna sezione del vault e abbastanza pertinente a questa richiesta.]' + (note ? '\n' + note : '') +
      '\nSe l\'informazione non c\'e nel profilo o nel resto del contesto, dillo con le parole indicate qui sopra, senza inventare.', fonti: [], giaPresenti, sezioni: 0, espanse };
  }
  const blocchi = [], fonti = []; let usati = 0, nSezioni = 0;
  for (const [percorso, sezioni] of perNota) {
    if (usati >= maxCaratteri) break;
    sezioni.sort((a, b) => a.inizio - b.inizio);                       // ordine del documento, non del punteggio
    const titolo = sezioni[0].titoloNota;
    const parti = [], frammenti = [];
    for (const s of sezioni) {
      const e = estrattoSezione(s.testo, r.radici);
      let testo = e.testo;
      const troncato = usati + testo.length > maxCaratteri;
      const frammento = troncato ? testo.slice(0, Math.max(0, maxCaratteri - usati)) : testo;
      if (troncato) testo = frammento + '\n[...troncato per il limite di contesto]';
      usati += testo.length; nSezioni++;
      // Gli offset delimitano la sezione originale, non un intervallo inventato per righe discontinue.
      frammenti.push({ sezione: s.sezione || '(inizio della nota)', inizioSezione: s.inizio, fineSezione: s.fine, testo: frammento, estratto: !e.intera, troncato });
      parti.push('<sezione percorso="' + (s.sezione || '(inizio della nota)').replace(/"/g, "'") + '"' + (e.intera ? '' : ' estratto="righe pertinenti"') + '>\n' + testo + '\n</sezione>');
      if (usati >= maxCaratteri) break;
    }
    fonti.push({ percorso, titolo, sezioni: frammenti.map(s => s.sezione), frammenti });
    blocchi.push('<nota percorso="' + percorso + '" titolo="' + String(titolo).replace(/"/g, "'") + '">\n' + parti.join('\n') + '\n</nota>');
  }
  const testo = '[Memoria di Orbit: queste sono le SEZIONI piu pertinenti delle note del vault (non le note intere), lette ora dai file originali; ' +
    'quando una sezione e lunga ci sono solo le righe che contengono i termini della domanda, e le parti omesse sono segnate con [...]. ' +
    'Basa la risposta su di esse e distingui quello che sta scritto da quello che deduci. Chiudi indicando le note usate con il loro percorso ' +
    '(es. scadenze/parziali.md); cita SOLO i percorsi delle note che vedi qui o nel profilo, non quelli che compaiono dentro i [[collegamenti]]. ' +
    'ASSENZE: queste sono solo alcune parti del vault. Se qualcosa non c\'e qui, scrivi "nelle parti del vault che ho letto non c\'e", ' +
    'non "le note non lo dicono" ne "nel vault non c\'e": un\'assenza dal vault la puoi affermare solo se qui sotto e indicata come verificata. ' +
    'Non modificare le note per rispondere.]' + (note ? '\n' + note : '') + '\n\n' + blocchi.join('\n\n');
  return { testo, fonti, giaPresenti, sezioni: nSezioni, espanse };
}

// Avvisi su sigle e assenze, con provenienza. Distingue: termine coperto dalle sezioni inviate; presente nel vault ma in parti non
// incluse (allora NON si puo dire che il vault non ne parla); assente da tutto il vault secondo l'indice (assenza verificata a livello di parole).
function avvisiAssenze(r, perNota, escludi = []) {
  const righe = [];
  for (const s of r.sigle || []) righe.push('[Sigla: ' + s.sigla + ' = ' + s.definizione + ' (definita in ' + s.percorso + (s.sezione ? ' > ' + s.sezione : '') + ')]');
  const inviate = [...perNota.values()].flat();
  const media = (r.termini || []).reduce((t, x) => t + x.peso, 0) / Math.max(1, (r.termini || []).length);
  (r.termini || []).forEach((t, i) => {
    if (t.peso < media - 1e-6) return;                                      // parole poco informative: niente avvisi (tolleranza: pesi uguali)
    if (inviate.some(s => (s.copre || [])[i] >= 0.7)) return;
    if (t.noteNelVault.some(p => escludi.includes(p))) return;               // e nel profilo, che arriva intero
    if (!t.noteNelVault.length) righe.push('[Assenza verificata: "' + t.termine + '" non compare in nessuna nota del vault (controllo sull\'indice delle parole).]');
    else righe.push('[Attenzione: "' + t.termine + '" compare anche in note non incluse qui (' + t.noteNelVault.slice(0, 4).join(', ') + '): non dire che il vault non ne parla.]');
  });
  return righe.join('\n');
}

// ---------- piano della giornata, riga per riga (passo 2) ----------
// Dal piano di studio non si manda piu tutta la nota, ma: le righe della tabella "giorno per giorno" delle date richieste
// (con il titoletto della settimana e l'intestazione della tabella), le regole del piano, e le informazioni COLLEGATE alle
// sigle degli argomenti di quel giorno (A6, M3...) nelle altre sezioni (domande di active recall, pagine della dispensa, cose da sapere).
// Dallo stato dei parziali: le sezioni sullo stato del ripasso. Se la riga del giorno non c'e (piano finito o formato diverso)
// restituisce null: chi chiama lo dice esplicitamente (vedi infoPiano) e usa solo lo stato, senza mandare le note intere.
const GIORNI = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
function estrattoPianoGiorno({ date = [], piano = 'scadenze/piano-di-studio.md', stato = 'scadenze/parziali.md', soloStato = false } = {}) {
  pronto();
  const blocchi = [];
  if (!soloStato) {
    const src = ricerca.leggiOriginale(piano);
    if (!src) return null;
    const righe = src.split('\n');
    const prese = new Set(); const sigle = new Set(); let trovate = 0;
    for (const data of date) {
      const d = new Date(data + 'T12:00:00Z'), abbr = GIORNI[d.getUTCDay()], num = d.getUTCDate();
      const re = new RegExp('^\\s*\\|\\s*' + abbr + '[a-z]*\\.?\\s+' + num + '(?!\\d)', 'i');
      righe.forEach((r, i) => {
        if (!re.test(r)) return;
        trovate++;
        let j = i; while (j > 0 && /^\s*\|/.test(righe[j - 1])) j--;
        let k = j - 1; while (k >= 0 && !righe[k].trim()) k--;
        if (k >= 0 && /^\s*\*\*/.test(righe[k])) prese.add(k);              // titoletto della settimana
        prese.add(j); if (j + 1 < i) prese.add(j + 1); prese.add(i);
        for (const m of r.matchAll(/\b([AM]\d)\b/g)) sigle.add(m[1]);
      });
    }
    if (!trovate) return null;
    const sezioni = sezioniNota(src);
    const parti = [];
    const regole = sezioni.find(s => /come funziona/i.test(s.titolo));
    if (regole) parti.push({ sezione: regole.percorso, testo: src.slice(regole.inizio, regole.fine).trim() });
    const giorno = sezioni.find(s => /giorno per giorno/i.test(s.titolo));
    parti.push({ sezione: giorno ? giorno.percorso : 'righe del giorno', testo: [...prese].sort((a, b) => a - b).map(i => righe[i]).join('\n'), estratto: true });
    if (sigle.size) {
      const reSigla = new RegExp('^\\s*\\*\\*\\s*(' + [...sigle].join('|') + ')\\b');
      for (const s of sezioni) {
        if (s === regole || s === giorno) continue;
        const paragrafi = src.slice(s.inizio, s.fine).split(/\n\s*\n/).filter(p => reSigla.test(p) || ([...sigle].some(x => new RegExp('\\b' + x + '\\b').test(p)) && /cose da sapere/i.test(s.titolo)));
        if (paragrafi.length) parti.push({ sezione: s.percorso, testo: paragrafi.map(p => p.trim()).join('\n\n'), estratto: true });
      }
    }
    blocchi.push({ percorso: piano, titolo: piano.split('/').pop().replace(/\.md$/, ''), parti });
  }
  const srcStato = ricerca.leggiOriginale(stato);
  if (srcStato) {
    const parti = sezioniNota(srcStato).filter(s => /stato|registro|avanzamento/i.test(s.titolo)).map(s => ({ sezione: s.percorso, testo: srcStato.slice(s.inizio, s.fine).trim() }));
    if (parti.length) blocchi.push({ percorso: stato, titolo: stato.split('/').pop().replace(/\.md$/, ''), parti });
  }
  return blocchi;
}

// Cosa c'e nel piano di studio, senza mandarlo al modello: se esiste, quante righe giorno per giorno ha e qual e l'ultima.
// Serve a dire con precisione "il piano non ha questa data" (finito, non aggiornato o assente) invece di ripiegare sulle note intere.
function infoPiano({ piano = 'scadenze/piano-di-studio.md' } = {}) {
  pronto();
  const src = ricerca.leggiOriginale(piano);
  if (!src) return { percorso: piano, esiste: false, giorni: 0, ultimoGiorno: null };
  const giorni = src.split('\n').map(r => r.match(/^\s*\|\s*((?:lun|mar|mer|gio|ven|sab|dom)[a-z]*\.?\s+\d{1,2}(?!\d)[^|]*?)\s*\|/i)).filter(Boolean).map(m => m[1].replace(/\s+/g, ' ').trim());
  return { percorso: piano, esiste: true, giorni: giorni.length, ultimoGiorno: giorni.length ? giorni[giorni.length - 1] : null };
}

function ricostruisci() {
  const v = config.verificaVault();
  if (!v.ok) throw new Error(v.errore);
  statoVault = v;
  indice.apri();
  if (!motoreRegistrato) { ricerca.registraMotore('testuale', ricerca.creaMotoreTestuale(indice)); motoreRegistrato = true; }
  return indice.ricostruisci();
}

module.exports = { avvia, stato, controlla, cerca, cercaNote, leggiNota, leggiSezioni, elencaNote, contestoPerDomanda, estrattoPianoGiorno, infoPiano, notificaModifica, ricostruisci, config, _estrattoSezione: estrattoSezione, _avvisiAssenze: avvisiAssenze };
