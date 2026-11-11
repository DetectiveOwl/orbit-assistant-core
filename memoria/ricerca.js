'use strict';
// Motori di ricerca intercambiabili. Ogni motore espone:
//   cerca(query, opzioni) -> [{ percorso, titolo, punteggio, estratto, motore }]
// Oggi c'e solo il motore "testuale" (SQLite FTS5). Un motore semantico o ibrido per il RAG
// si aggiunge con registraMotore('semantico', { cerca }) senza toccare il resto di Orbit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const STOPWORD = new Set(('a ad al allo ai agli all alla alle che chi ci come con cosa cui da dal dallo dai dagli ' +
  'dall dalla dalle de del dello dei degli dell della delle di do dove e ed è fa gli ha hai ho i il in io la le lei ' +
  'li lo loro lui ma mi mia mie miei mio ne nei negli nel nello nell nella nelle noi o per perché piu più quale ' +
  'quali quando quanto quello questa queste questi questo se sei si sia siamo sono su sul sullo sui sugli sull ' +
  'sulla sulle ti tra tu tua tue tuo tuoi un una uno vi voi c l s t m d sto stai sta me te ' +
  // verbi e parole funzionali delle domande: non dicono nulla su QUALE nota serve, ma essendo rari nel vault pesavano troppo
  'faccio fai fa fanno fare fatto devo devi deve dovrei posso puoi puo potrei voglio vuoi vorrei so sai sapere ho hai abbiamo era ' +
  'dimmi dici dire ricordi ricordami mi ti cos qual quali cosa cose quanto quanta come dov quand perche anche ancora gia ' +
  // riferimenti temporali relativi: il giorno lo risolvono il piano o il calendario, non la ricerca nel testo
  'oggi domani ieri stasera stamattina adesso ora').split(' '));

const motori = new Map();
function registraMotore(nome, motore) { motori.set(nome, motore); }
function motore(nome) {
  const m = motori.get(nome || 'testuale');
  if (!m) throw new Error('Motore di ricerca sconosciuto: ' + nome);
  return m;
}

function normalizza(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Separa i filtri (tag:x, cartella:x) dalle parole da cercare.
function analizzaQuery(query, opzioni = {}) {
  const tag = [].concat(opzioni.tag || []).map(t => String(t).replace(/^#/, '').toLowerCase());
  let cartella = opzioni.cartella || null;
  const libere = [];
  for (const pezzo of String(query || '').split(/\s+/)) {
    const f = pezzo.match(/^(tag|cartella):(.+)$/i);
    if (f && f[1].toLowerCase() === 'tag') tag.push(f[2].replace(/^#/, '').toLowerCase());
    else if (f) cartella = f[2];
    else if (pezzo.startsWith('#') && pezzo.length > 1) tag.push(pezzo.slice(1).toLowerCase());
    else libere.push(pezzo);
  }
  // Solo la cornice di una ricerca esplicita: "appunti" e "spiegazione" restano termini se sono il soggetto.
  const testo = normalizza(libere.join(' ')).replace(
    /^(?:cerca|trova)(?:mi)?\s+(?:nei miei appunti|negli appunti|nelle mie note|nelle note|nei tuoi appunti)\s+(?:(?:la |una )?(?:spiegazione|definizione|descrizione|informazioni)\s+(?:di|del|dello|della|dei|degli|delle|su|sul|sullo|sulla|sui|sugli|sulle)\s+)?/,
    '');
  const termini = [];
  for (const t of testo.match(/[\p{L}\p{N}]+/gu) || []) {
    if (STOPWORD.has(t) || termini.includes(t)) continue;
    termini.push(t);
  }
  return { termini, tag, cartella: cartella ? cartella.replace(/\\/g, '/').replace(/\/$/, '') : null };
}

// Radice approssimativa italiana: "matrici" e "matrice" diventano entrambe "matric*".
function radice(t) {
  if (t.length >= 5 && /[aeiou]$/.test(t)) return t.slice(0, -1);
  return t;
}

// Trova nel testo originale il pezzo con piu parole cercate e lo restituisce come estratto.
function estratto(testo, termini, lunghezza = 280) {
  const piatto = testo.replace(/\s+/g, ' ');
  if (!termini.length) return piatto.slice(0, lunghezza);
  const norm = normalizza(piatto);
  const posizioni = [];
  for (const t of termini) {
    const r = radice(t);
    let i = norm.indexOf(r);
    while (i >= 0) { posizioni.push(i); i = norm.indexOf(r, i + r.length); }
  }
  if (!posizioni.length) return piatto.slice(0, lunghezza);
  posizioni.sort((a, b) => a - b);
  let migliore = posizioni[0], max = 0;
  for (const p of posizioni) {
    const n = posizioni.filter(q => q >= p && q < p + lunghezza).length;
    if (n > max) { max = n; migliore = p; }
  }
  const inizio = Math.max(0, migliore - 60);
  return (inizio > 0 ? '...' : '') + piatto.slice(inizio, inizio + lunghezza).trim() + (inizio + lunghezza < piatto.length ? '...' : '');
}

// Testi delle note letti dal vault, tenuti in memoria finche il file non cambia (controllo con stat: dimensione e data).
// E solo una cache di lettura: la fonte resta il file, che viene riletto appena cambia.
const testi = new Map();
const MAX_TESTI = 300;
function leggiOriginale(percorso) {
  const abs = path.join(config.vaultPath, percorso);
  let st; try { st = fs.statSync(abs); } catch (e) { testi.delete(percorso); return ''; }
  const c = testi.get(percorso);
  if (c && c.mtime === st.mtimeMs && c.dimensione === st.size) return c.testo;
  let testo; try { testo = fs.readFileSync(abs, 'utf8'); } catch (e) { return ''; }
  if (testi.size >= MAX_TESTI) testi.delete(testi.keys().next().value);
  testi.set(percorso, { mtime: st.mtimeMs, dimensione: st.size, testo, norm: null });
  return testo;
}
function leggiNormalizzato(percorso) {
  const t = leggiOriginale(percorso); const c = testi.get(percorso);
  if (!c) return normalizza(t);
  if (c.norm === null) c.norm = normalizza(t);
  return c.norm;
}

// Soglia di pertinenza (calibrata sul benchmark di orbit/tools/bench-memoria.js):
// "copertura pesata" = quota del peso dei termini della domanda che compaiono nella nota, dove i termini rari nel vault pesano di piu
// (una parola come "carbonara", che non c'e da nessuna parte, pesa molto: se manca, la nota non risponde alla domanda).
// Una nota passa se copre almeno SOGLIA_ASSOLUTA del peso e almeno SOGLIA_RELATIVA della migliore.
const SOGLIA_ASSOLUTA = 0.4;
const SOGLIA_RELATIVA = 0.5;

function creaMotoreTestuale(indice) {
  const cache = new Map(); let versioneCache = -1;
  const MAX_CACHE = 200;
  // Freschezza della cache (correzione finale): ogni risultato ricorda la "firma" (data di modifica e dimensione) dei file da cui
  // viene il suo testo, cioe la versione effettivamente letta. Quando lo si riusa si controllano SOLO quei file con uno stat:
  // se uno e cambiato si reindicizza solo quello, se e sparito (eliminazione o rinomina) si fa la scansione incrementale; poi si rifa la ricerca.
  const firmaFile = p => { try { const st = fs.statSync(path.join(config.vaultPath, p)); return st.mtimeMs + ':' + st.size; } catch (e) { return 'assente'; } };
  const firmaLetta = p => { const c = testi.get(p); return c ? c.mtime + ':' + c.dimensione : firmaFile(p); };
  const firme = percorsi => { const f = {}; for (const p of new Set(percorsi)) f[p] = firmaLetta(p); return f; };
  const fresca = voce => {
    const cambiati = Object.keys(voce.firme).filter(p => firmaFile(p) !== voce.firme[p]);
    if (!cambiati.length) return true;
    if (cambiati.some(p => firmaFile(p) === 'assente')) indice.sincronizza({ forza: true });
    else for (const p of cambiati) indice.aggiornaFile(p);
    cache.clear(); versioneCache = indice.versione;
    return false;
  };
  const usaCache = chiave => { const v = cache.get(chiave); return v && fresca(v) ? v : null; };
  return {
    nome: 'testuale',
    cerca(query, opzioni = {}) {
      // Cache dei risultati: la chiave e la domanda con i parametri; tutto si svuota quando l'indice cambia (modifica, rinomina, eliminazione).
      if (versioneCache !== indice.versione) { cache.clear(); versioneCache = indice.versione; }
      const chiave = JSON.stringify([String(query || '').trim().toLowerCase(), opzioni.limite || 8, opzioni.cartella || null, [].concat(opzioni.tag || []), opzioni.soglia !== false]);
      const v = usaCache(chiave);
      if (v) return v.r.map(r => Object.assign({}, r, { tag: r.tag.slice() }));
      const risultati = this._cerca(query, opzioni);
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(chiave, { r: risultati, firme: firme(risultati.map(x => x.percorso)) });
      return risultati.map(r => Object.assign({}, r, { tag: r.tag.slice() }));
    },
    // ---------- ricerca per sezioni (passo 2) ----------
    // Restituisce le sezioni pertinenti (non le note intere), con percorso della nota, percorso delle intestazioni e testo
    // riletto dal file originale. Stessa copertura pesata e stessa soglia della ricerca per note; in piu, se un termine raro della
    // domanda non e coperto dalle sezioni scelte, si aggiunge la migliore sezione che lo copre (informazioni distribuite).
    cercaSezioni(query, opzioni = {}) {
      if (versioneCache !== indice.versione) { cache.clear(); versioneCache = indice.versione; }
      const chiave = 'S' + JSON.stringify([String(query || '').trim().toLowerCase(), opzioni.limite || 6, opzioni.soglia !== false, opzioni.cartella || null, [].concat(opzioni.tag || [])]);
      const v = usaCache(chiave);
      if (v) return JSON.parse(JSON.stringify(v.r));
      let r = this._cercaSezioni(query, opzioni);
      if (r === null) { indice.sincronizza({ forza: true }); cache.clear(); versioneCache = indice.versione; r = this._cercaSezioni(query, opzioni) || { sezioni: [], radici: [] }; }
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(chiave, { r, firme: firme((r.sezioni || []).concat(r.altri || []).map(s => s.percorso)) });
      return JSON.parse(JSON.stringify(r));
    },
    _cercaSezioni(query, opzioni = {}) {
      const db = indice.db;
      const limite = Math.max(1, Math.min(Number(opzioni.limite) || 6, 20));
      const q = analizzaQuery(query, opzioni);
      if (!q.termini.length) return { sezioni: [], radici: [] };
      const radici = q.termini.map(radice);
      // Sigle (passo 3): se un termine e una sigla definita nel vault ("Nome Esteso (SIGLA)"), una sezione la copre anche
      // quando usa il nome esteso o la sua parola principale. Il dizionario e derivato dal vault, nessuna regola per sigle specifiche.
      const dizionario = this.sigle();
      const alias = q.termini.map(t => dizionario.get(t) || null);
      const termMatch = radici.concat(alias.filter(Boolean).map(a => a.testa));
      const match = [...new Set(termMatch)].map(t => '"' + t + '"*').join(' OR ');
      const N = Math.max(1, db.prepare('SELECT count(*) c FROM note').get().c);
      const df = db.prepare('SELECT count(*) c FROM note_fts WHERE note_fts MATCH ?');
      const peso = q.termini.map(t => { let d = 0; try { d = df.get('"' + radice(t) + '"*').c; } catch (e) { d = 0; } return Math.log(1 + (N + 1) / (d + 0.5)); });
      // 1 = il termine c'e; 0.7 = c'e solo il nome esteso della sigla o la sua parola principale (vale un po' meno della sigla stessa)
      const presente = (testoNorm, i) => testoNorm.includes(radici[i]) ? 1 : (alias[i] && (testoNorm.includes(alias[i].definizioneNorm) || testoNorm.includes(alias[i].testa))) ? 0.7 : 0;
      const totale = peso.reduce((s, x) => s + x, 0) || 1;
      const filtri = [], parametri = [];
      if (q.cartella) { filtri.push("(n.percorso = ? OR n.percorso LIKE ? ESCAPE '\\')"); parametri.push(q.cartella, q.cartella.replace(/[%_\\]/g, '\\$&') + '/%'); }
      for (const t of q.tag) { filtri.push('EXISTS (SELECT 1 FROM json_each(n.tag) WHERE value = ? OR value LIKE ?)'); parametri.push(t, t + '/%'); }
      const dove = filtri.length ? ' AND ' + filtri.join(' AND ') : '';
      let righe;
      try {
        righe = db.prepare(`SELECT s.id, s.percorso_sezione, s.inizio, s.fine, s.hash, n.percorso, n.titolo AS titolo_nota, bm25(sezioni_fts, 2, 4, 1) AS rank
          FROM sezioni_fts JOIN sezioni s ON s.id = sezioni_fts.rowid JOIN note n ON n.id = s.nota WHERE sezioni_fts MATCH ?${dove} ORDER BY rank LIMIT 80`).all(match, ...parametri);
      } catch (e) { return { sezioni: [], radici }; }
      const candidati = [];
      for (const r of righe) {
        const testo = leggiOriginale(r.percorso).slice(r.inizio, r.fine);
        // l'indice e indietro rispetto al file (modifica nell'ultimo secondo e mezzo): si risincronizza e si ripete
        if (crypto.createHash('sha1').update(testo).digest('hex') !== r.hash) return null;
        const corpo = normalizza(r.percorso_sezione + ' ' + testo), nota = normalizza(r.titolo_nota + ' ' + r.percorso);
        const copre = radici.map((t, i) => presente(corpo, i) || presente(nota, i) * 0.5);
        const pertinenza = copre.reduce((s, c, i) => s + c * peso[i], 0) / totale;
        candidati.push({ percorso: r.percorso, titoloNota: r.titolo_nota, sezione: r.percorso_sezione, inizio: r.inizio, fine: r.fine, testo, pertinenza, rank: r.rank, copre });
      }
      candidati.sort((a, b) => b.pertinenza - a.pertinenza || a.rank - b.rank);
      let scelte = candidati;
      if (opzioni.soglia !== false && candidati.length) {
        const migliore = candidati[0].pertinenza;
        scelte = candidati.filter(c => c.pertinenza >= SOGLIA_ASSOLUTA && c.pertinenza >= SOGLIA_RELATIVA * migliore);
      }
      scelte = scelte.slice(0, limite);
      // Informazioni distribuite: termini rari (peso sopra la media) non coperti dal testo delle sezioni scelte.
      const medio = totale / q.termini.length;
      for (let i = 0; i < q.termini.length && scelte.length; i++) {
        if (peso[i] < medio || scelte.some(s => s.copre[i] >= 0.7)) continue;
        const extra = candidati.find(c => c.copre[i] >= 0.7 && !scelte.includes(c) && c.pertinenza >= SOGLIA_ASSOLUTA / 2);
        if (extra && scelte.length < limite + 2) scelte.push(Object.assign(extra, { complemento: q.termini[i] }));
      }
      const forma = c => ({ percorso: c.percorso, titoloNota: c.titoloNota, sezione: c.sezione, inizio: c.inizio, fine: c.fine, testo: c.testo, pertinenza: Math.round(c.pertinenza * 100) / 100, complemento: c.complemento || null, copre: c.copre });
      // Per l'espansione (passo 3): candidati non scelti ma ancora pertinenti, in ordine di pertinenza.
      const altri = candidati.filter(c => !scelte.includes(c) && c.pertinenza >= SOGLIA_ASSOLUTA / 2).slice(0, 12).map(forma);
      // Per le assenze: per ogni termine, se compare nel vault e in quali note (cosi "non e nel contesto" non diventa "non e nel vault").
      const inNote = db.prepare('SELECT n.percorso FROM note_fts JOIN note n ON n.id = note_fts.rowid WHERE note_fts MATCH ? LIMIT 5');
      const termini = q.termini.map((t, i) => {
        let note = []; try { note = inNote.all('"' + radici[i] + '"*' + (alias[i] ? ' OR "' + alias[i].testa + '"*' : '')).map(x => x.percorso); } catch (e) { note = []; }
        return { termine: t, peso: Math.round(peso[i] * 100) / 100, noteNelVault: note };
      });
      const radiciEstese = [...new Set(radici.concat(alias.filter(Boolean).flatMap(a => [a.testa, a.definizioneNorm])))];
      return { radici: radiciEstese, termini, sigle: alias.filter(Boolean).map(a => ({ sigla: a.sigla, definizione: a.definizione, percorso: a.percorso, sezione: a.sezione })),
        sezioni: scelte.map(forma), altri };
    },

    // Dizionario delle sigle definite nel vault, nelle forme "Nome Esteso (SIGLA)" e "SIGLA (Nome Esteso)".
    // Una sigla vale solo se le sue lettere maiuscole coincidono (in qualsiasi ordine) con le iniziali delle parole del nome esteso.
    // Derivato dalle note e tenuto solo in memoria, ricalcolato quando cambia l'indice: nessuna seconda fonte di verita.
    sigle() {
      if (this._sigle && this._sigleVersione === indice.versione) return this._sigle;
      const mappa = new Map();
      const CONNETTIVI = new Set(['e', 'ed', 'di', 'del', 'della', 'dei', 'delle', 'degli', 'da', 'la', 'il', 'lo', 'le', 'i', 'gli', 'a', 'al', 'per', 'in', 'of', 'and', 'the']);
      const iniziali = parole => parole.filter(p => !CONNETTIVI.has(p.toLowerCase())).map(p => p[0].toUpperCase()).sort().join('');
      const lettere = s => s.replace(/[^\p{Lu}]/gu, '').split('').sort().join('');
      const sezioni = indice.db.prepare('SELECT s.percorso_sezione, s.inizio, s.fine FROM sezioni s JOIN note n ON n.id = s.nota WHERE n.percorso = ?');
      for (const { percorso } of indice.db.prepare('SELECT percorso FROM note').all()) {
        const testo = leggiOriginale(percorso);
        const registra = (sigla, parole, pos) => {
          const key = normalizza(sigla);
          if (mappa.has(key) || sigla.length < 2) return;
          const L = lettere(sigla);
          // si cerca il gruppo minimo di parole (le ultime prima della parentesi, o le prime dopo) con le stesse iniziali
          for (let k = 1; k <= parole.length; k++) {
            const gruppo = parole.slice(parole.length - k);
            if (iniziali(gruppo) === L && /^\p{Lu}/u.test(gruppo[0])) {
              const definizione = gruppo.join(' ');
              const testa = radice(normalizza(gruppo.find(p => !CONNETTIVI.has(p.toLowerCase()))));
              const sez = sezioni.all(percorso).find(s => pos >= s.inizio && pos < s.fine);
              mappa.set(key, { sigla, definizione, definizioneNorm: normalizza(definizione), testa, percorso, sezione: sez ? sez.percorso_sezione : '' });
              return;
            }
          }
        };
        for (const m of testo.matchAll(/((?:[\p{L}'’]+[ \t]+){0,7}[\p{L}'’]+)[ \t]*\((\p{Lu}[\p{L}\d]{1,7})\)/gu)) {
          if ((m[2].match(/\p{Lu}/gu) || []).length < 2) continue;
          registra(m[2], m[1].split(/[ \t]+/), m.index);
        }
        for (const m of testo.matchAll(/\b(\p{Lu}{2,8})[ \t]*\(([^()\n]{4,80})\)/gu)) {
          const parole = m[2].split(/[ \t]+/).filter(Boolean);
          for (let k = parole.length; k >= 1; k--) { const g = parole.slice(0, k); if (iniziali(g) === lettere(m[1])) { registra(m[1], g, m.index); break; } }
        }
      }
      this._sigle = mappa; this._sigleVersione = indice.versione;
      return mappa;
    },
    _cerca(query, opzioni = {}) {
      const db = indice.db;
      const limite = Math.max(1, Math.min(Number(opzioni.limite) || 8, 50));
      const q = analizzaQuery(query, opzioni);

      const filtri = [], parametri = [];
      if (q.cartella) { filtri.push("(n.percorso = ? OR n.percorso LIKE ? ESCAPE '\\')"); parametri.push(q.cartella, q.cartella.replace(/[%_\\]/g, '\\$&') + '/%'); }
      for (const t of q.tag) { filtri.push('EXISTS (SELECT 1 FROM json_each(n.tag) WHERE value = ? OR value LIKE ?)'); parametri.push(t, t + '/%'); }
      const dove = filtri.length ? ' AND ' + filtri.join(' AND ') : '';

      let righe;
      if (q.termini.length) {
        const match = q.termini.map(t => '"' + radice(t) + '"*').join(' OR ');
        // Pesi: titolo, percorso, alias, tag, intestazioni, metadati, testo
        righe = db.prepare(`SELECT n.percorso, n.titolo, n.tag, bm25(note_fts, 10, 4, 8, 6, 3, 2, 1) AS rank
          FROM note_fts JOIN note n ON n.id = note_fts.rowid
          WHERE note_fts MATCH ?${dove} ORDER BY rank LIMIT ?`).all(match, ...parametri, limite * 4);
        // Con poche note bm25 distingue male, quindi prima conta quante parole diverse della domanda
        // compaiono nella nota (titolo e percorso valgono doppio), poi usa bm25 per gli spareggi.
        // Peso dei termini: piu e raro nel vault, piu conta (frequenza documentale dall'indice FTS, nessuna lettura di file).
        const N = Math.max(1, db.prepare('SELECT count(*) c FROM note').get().c);
        const df = db.prepare('SELECT count(*) c FROM note_fts WHERE note_fts MATCH ?');
        const peso = {};
        for (const t of q.termini) { let d = 0; try { d = df.get('"' + radice(t) + '"*').c; } catch (e) { d = 0; } peso[t] = Math.log(1 + (N + 1) / (d + 0.5)); }
        const pesoTotale = q.termini.reduce((s, t) => s + peso[t], 0) || 1;
        for (const r of righe) {
          const testo = leggiNormalizzato(r.percorso);
          const intestazione = normalizza(r.titolo + ' ' + r.percorso);
          r.copertura = q.termini.reduce((s, t) => s + (testo.includes(radice(t)) ? 1 : 0) + (intestazione.includes(radice(t)) ? 1 : 0), 0);
          r.pertinenza = q.termini.reduce((s, t) => s + (testo.includes(radice(t)) || intestazione.includes(radice(t)) ? peso[t] : 0), 0) / pesoTotale;
        }
        righe.sort((a, b) => b.pertinenza - a.pertinenza || b.copertura - a.copertura || a.rank - b.rank);
        if (opzioni.soglia !== false && righe.length) {
          const migliore = righe[0].pertinenza;
          righe = righe.filter(r => r.pertinenza >= SOGLIA_ASSOLUTA && r.pertinenza >= SOGLIA_RELATIVA * migliore);
        }
        righe = righe.slice(0, limite);
      } else if (filtri.length) {
        righe = db.prepare(`SELECT n.percorso, n.titolo, n.tag, 0 AS rank FROM note n WHERE 1=1${dove}
          ORDER BY n.mtime DESC LIMIT ?`).all(...parametri, limite);
      } else {
        return [];
      }

      // Rete di sicurezza: se l'indice non trova nulla, cerca la frase esatta nei file originali.
      if (!righe.length && q.termini.length) {
        const frase = normalizza(String(query).trim());
        righe = db.prepare(`SELECT n.percorso, n.titolo, n.tag, 0 AS rank FROM note n WHERE 1=1${dove}`).all(...parametri)
          .filter(r => normalizza(leggiOriginale(r.percorso)).includes(frase)).slice(0, limite);
      }

      return righe.map(r => ({
        percorso: r.percorso,
        titolo: r.titolo,
        tag: JSON.parse(r.tag || '[]'),
        punteggio: (r.copertura || 0) + Math.round(-r.rank * 1000) / 1000,
        pertinenza: r.pertinenza !== undefined ? Math.round(r.pertinenza * 100) / 100 : null,
        estratto: estratto(leggiOriginale(r.percorso), q.termini),
        motore: 'testuale'
      }));
    }
  };
}

module.exports = { registraMotore, motore, creaMotoreTestuale, analizzaQuery, normalizza, radice, leggiOriginale, SOGLIA_ASSOLUTA, SOGLIA_RELATIVA };
