'use strict';
// Indice SQLite delle note, tenuto fuori dal vault e sempre ricostruibile.
// L'indice full text e "contentless": contiene solo le parole indicizzate, non una copia delle note.
// Il testo vero viene sempre riletto dai file originali del vault.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { analizzaNota, sezioniNota } = require('./analisi');

// 2: aggiunte le sezioni (passo 2 della memoria). Cambiando versione l'indice si ricostruisce da solo dal vault.
const VERSIONE_SCHEMA = '2';
const INTERVALLO_MINIMO_MS = 1500;   // sotto questo intervallo non riscansiona il vault

function aPercorsoVault(abs) {
  return path.relative(config.vaultPath, abs).split(path.sep).join('/');
}

// Elenca file Markdown e allegati del vault, saltando le cartelle tecniche.
function scansiona(dir, note, allegati) {
  let voci;
  try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const v of voci) {
    const abs = path.join(dir, v.name);
    if (v.isDirectory()) {
      if (!config.cartellaEsclusa(v.name)) scansiona(abs, note, allegati);
    } else if (v.isFile()) {
      if (/\.md$/i.test(v.name)) note.push(abs);
      else allegati.push(abs);
    }
  }
}

class Indice {
  constructor() {
    this.db = null;
    this.ultimaScansione = 0;
    this.versione = 0;          // cresce a ogni cambiamento dell'indice: invalida le cache derivate (ricerche e testi letti)
  }

  apri() {
    if (this.db) return;
    fs.mkdirSync(config.indexDir, { recursive: true });
    try { this._apriEControlla(); }
    catch (e) {
      if (!this._corrotto(e)) throw e;
      try { this._mettiDaParteCorrotto(e); }   // una sola volta per processo; copia i byte PRIMA di chiudere (la chiusura scarica il WAL nel file)
      catch (x) { this._chiudiSilenzioso(); throw x; }
      this._apriEControlla();
    }
  }

  // Apre il file e ne verifica la struttura (una volta per apertura): cosi la corruzione emerge subito, non dipende da quale
  // operazione (ricerca o sincronizzazione) arriva per prima.
  _apriEControlla() {
    try {
      this.db = new DatabaseSync(config.indexFile);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      const q = this.db.prepare('PRAGMA quick_check').all();
      if (q.length !== 1 || q[0].quick_check !== 'ok') throw Object.assign(new Error('database disk image is malformed: ' + q.map(r => r.quick_check).join('; ').slice(0, 300)), { errcode: 11 });
      if (this._versione() !== VERSIONE_SCHEMA) this._creaSchema();
    } catch (e) {
      if (!this._corrotto(e)) this._chiudiSilenzioso();   // se corrotto resta aperta: la chiusura riscriverebbe il file prima della copia
      throw e;
    }
  }

  _chiudiSilenzioso() {
    if (this.db) { try { this.db.close(); } catch (x) { /* gia chiuso */ } this.db = null; }
  }

  _versione() {
    try { const r = this.db.prepare("SELECT valore FROM meta WHERE chiave = 'schema'").get(); return r && r.valore; }
    catch (e) { return null; }
  }

  _creaSchema() {
    this.db.exec(`
      DROP TABLE IF EXISTS note_fts; DROP TABLE IF EXISTS link; DROP TABLE IF EXISTS allegati;
      DROP TABLE IF EXISTS sezioni_fts; DROP TABLE IF EXISTS sezioni;
      DROP TABLE IF EXISTS note; DROP TABLE IF EXISTS meta;
      CREATE TABLE meta (chiave TEXT PRIMARY KEY, valore TEXT);
      CREATE TABLE note (
        id INTEGER PRIMARY KEY, percorso TEXT UNIQUE NOT NULL, titolo TEXT, nome_file TEXT,
        alias TEXT, tag TEXT, intestazioni TEXT, frontmatter TEXT,
        mtime REAL, dimensione INTEGER, hash TEXT, parole INTEGER, indicizzata_il TEXT);
      CREATE TABLE link (sorgente INTEGER NOT NULL, destinazione TEXT NOT NULL, sezione TEXT, embed INTEGER);
      CREATE INDEX link_sorgente ON link(sorgente);
      CREATE TABLE allegati (percorso TEXT PRIMARY KEY, estensione TEXT, dimensione INTEGER, mtime REAL);
      CREATE VIRTUAL TABLE note_fts USING fts5(
        titolo, percorso, alias, tag, intestazioni, metadati, testo,
        content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
      -- Sezioni: solo posizioni nel file originale e un hash per accorgersi se il testo e cambiato. Nessuna copia del testo.
      CREATE TABLE sezioni (id INTEGER PRIMARY KEY, nota INTEGER NOT NULL, ordine INTEGER, livello INTEGER, titolo TEXT, percorso_sezione TEXT,
        inizio INTEGER, fine INTEGER, hash TEXT);
      CREATE INDEX sezioni_nota ON sezioni(nota);
      CREATE VIRTUAL TABLE sezioni_fts USING fts5(titolo_nota, sezione, testo,
        content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
    `);
    this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema', VERSIONE_SCHEMA);
    this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('vault', config.vaultPath);
  }

  // Cancella l'indice e lo rifa da zero leggendo il vault.
  ricostruisci() {
    this.apri();
    this._creaSchema();
    this.ultimaScansione = 0;
    return this.sincronizza({ forza: true });
  }

  // Un file SQLite danneggiato (pagine illeggibili, indice UNIQUE non allineato alla tabella, tabelle full text rotte) non si ripara con
  // un secondo tentativo: l'indice e solo una cache del vault, quindi si mette da parte il file corrotto (mai cancellato) e si rifa.
  _corrotto(e) {
    return e && ((e.errcode & 0xff) === 11 || (e.errcode & 0xff) === 26 ||
      /malformed|not a database|vtable constructor failed|UNIQUE constraint failed: note\.percorso/i.test(String(e.message)));
  }

  // Mette da parte il file corrotto CON i suoi -wal e -shm, senza cancellare nulla: prima una copia esatta dei byte, poi chiude la
  // connessione (che puo scaricare il WAL nel file) e sposta anche quel che resta. Una sola volta per processo.
  _mettiDaParteCorrotto(causa) {
    if (this.recuperato) {
      throw new Error('L\'indice SQLite risulta corrotto anche dopo la ricostruzione (gia messo da parte come ' + this.recuperato + '): ' + causa.message, { cause: causa });
    }
    const stamp = new Date().toISOString().replace(/[-:.Z]/g, '');   // fino ai millisecondi: due recuperi non si sovrascrivono mai
    const base = config.indexFile.replace(/\.sqlite$/, '');
    const suffissi = ['.sqlite', '.sqlite-wal', '.sqlite-shm'].filter(x => fs.existsSync(base + x));
    const copie = [];
    try {
      for (const x of suffissi) { fs.copyFileSync(base + x, `${base}.corrotto-${stamp}${x}`, fs.constants.COPYFILE_EXCL); copie.push(`${base}.corrotto-${stamp}${x}`); }
      if (this.db) { try { this.db.close(); } catch (e) { /* gia chiuso o danneggiato */ } this.db = null; }
      for (const x of suffissi) if (fs.existsSync(base + x)) fs.renameSync(base + x, `${base}.corrotto-${stamp}.chiuso${x}`);
    } catch (x) {
      for (const c of copie) { try { fs.unlinkSync(c); } catch (e) { /* copia appena creata da noi */ } }
      throw new Error('L\'indice SQLite e corrotto ma non riesco a metterlo da parte (chiudi le altre istanze di Orbit e riavvia): ' + x.message, { cause: causa });
    }
    this.recuperato = `${path.basename(base)}.corrotto-${stamp}.sqlite`;
    this.ultimaScansione = 0;
    this.versione++;
  }

  // Aggiornamento incrementale con recupero: se l'indice e fisicamente corrotto lo isola e lo ricostruisce, una volta sola.
  // Gli altri errori (SQL, disco, lock) non sono corruzione e vengono rilanciati cosi come sono.
  sincronizza(opzioni = {}) {
    try { return this._sincronizza(opzioni); }
    catch (e) {
      if (!this._corrotto(e)) throw e;
      this._mettiDaParteCorrotto(e);
      try { return this._sincronizza({ ...opzioni, forza: true }); }
      catch (x) { throw new Error('Indice corrotto messo da parte come ' + this.recuperato + ', ma la ricostruzione e fallita: ' + x.message, { cause: x }); }
    }
  }

  // Aggiornamento incrementale: reindicizza solo le note nuove, modificate o cancellate.
  // Confronta data di modifica e dimensione, e solo se cambiano rilegge il file e ne controlla l'hash.
  _sincronizza({ forza = false } = {}) {
    this.apri();
    const ora = Date.now();
    if (!forza && ora - this.ultimaScansione < INTERVALLO_MINIMO_MS) return { saltata: true };
    this.ultimaScansione = ora;

    const fileNote = [], fileAllegati = [];
    scansiona(config.vaultPath, fileNote, fileAllegati);

    const esito = { aggiunte: 0, aggiornate: 0, rimosse: 0, invariate: 0 };
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const esistenti = new Map();
      for (const r of db.prepare('SELECT id, percorso, mtime, dimensione, hash FROM note').all()) esistenti.set(r.percorso, r);

      const visti = new Set();
      for (const abs of fileNote) {
        const rel = aPercorsoVault(abs);
        if (config.fileEscluso(rel)) continue;             // documento escluso dalla memoria: se era nell'indice, qui sotto viene rimosso
        if (visti.has(rel)) continue;                      // stesso percorso incontrato due volte: una sola riga per percorso
        visti.add(rel);
        let st;
        try { st = fs.statSync(abs); } catch (e) { continue; }
        const prima = esistenti.get(rel);
        if (prima && prima.mtime === st.mtimeMs && prima.dimensione === st.size) { esito.invariate++; continue; }
        let src;
        try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
        const hash = crypto.createHash('sha1').update(src).digest('hex');
        if (prima && prima.hash === hash) {
          db.prepare('UPDATE note SET mtime = ?, dimensione = ? WHERE id = ?').run(st.mtimeMs, st.size, prima.id);
          esito.invariate++;
          continue;
        }
        this._indicizzaNota(rel, src, st, hash, prima ? prima.id : null);
        if (prima) esito.aggiornate++; else esito.aggiunte++;
      }

      for (const [rel, r] of esistenti) {
        if (visti.has(rel)) continue;
        db.prepare('DELETE FROM note_fts WHERE rowid = ?').run(r.id);
        db.prepare('DELETE FROM link WHERE sorgente = ?').run(r.id);
        this._cancellaSezioni(r.id);
        db.prepare('DELETE FROM note WHERE id = ?').run(r.id);
        esito.rimosse++;
      }

      db.exec('DELETE FROM allegati');
      const insA = db.prepare('INSERT OR REPLACE INTO allegati VALUES (?, ?, ?, ?)');
      for (const abs of fileAllegati) {
        try {
          const st = fs.statSync(abs);
          insA.run(aPercorsoVault(abs), path.extname(abs).slice(1).toLowerCase(), st.size, st.mtimeMs);
        } catch (e) { /* file sparito durante la scansione */ }
      }

      db.prepare("INSERT OR REPLACE INTO meta VALUES ('ultimo_aggiornamento', ?)").run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      this.versione++;
      throw e;
    }
    if (forza || esito.aggiunte || esito.aggiornate || esito.rimosse) this.versione++;
    return esito;
  }

  // Aggiornamento MIRATO di una sola nota (scrittura fatta da Orbit, o file cambiato visto da una cache): niente scansione del vault.
  // Se il file non c'e piu, la nota esce dall'indice. Restituisce cosa e successo; la versione cresce solo se l'indice cambia.
  aggiornaFile(rel) {
    this.apri();
    const pulito = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/\.md$/i.test(pulito) || pulito.split('/').some(s => s === '..' || config.cartellaEsclusa(s))) return { saltata: true };
    const abs = path.join(config.vaultPath, ...pulito.split('/'));
    const db = this.db;
    // un documento escluso dalla memoria si tratta come se non esistesse (se era nell'indice, viene rimosso)
    let st = null; try { st = fs.statSync(abs); if (!st.isFile() || config.fileEscluso(pulito)) st = null; } catch (e) { st = null; }
    let esito = 'invariata';
    db.exec('BEGIN IMMEDIATE');
    try {
      // letta DENTRO la transazione: un altro processo puo aver indicizzato la nota nel frattempo (altrimenti INSERT doppio e UNIQUE)
      const prima = db.prepare('SELECT id, mtime, dimensione, hash FROM note WHERE percorso = ?').get(pulito);
      if (!st) {
        if (prima) {
          db.prepare('DELETE FROM note_fts WHERE rowid = ?').run(prima.id);
          db.prepare('DELETE FROM link WHERE sorgente = ?').run(prima.id);
          this._cancellaSezioni(prima.id);
          db.prepare('DELETE FROM note WHERE id = ?').run(prima.id);
          esito = 'rimossa';
        }
      } else if (!prima || prima.mtime !== st.mtimeMs || prima.dimensione !== st.size) {
        const src = fs.readFileSync(abs, 'utf8');
        const hash = crypto.createHash('sha1').update(src).digest('hex');
        if (prima && prima.hash === hash) db.prepare('UPDATE note SET mtime = ?, dimensione = ? WHERE id = ?').run(st.mtimeMs, st.size, prima.id);
        else { this._indicizzaNota(pulito, src, st, hash, prima ? prima.id : null); esito = prima ? 'aggiornata' : 'aggiunta'; }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); this.versione++; throw e; }
    if (esito !== 'invariata') this.versione++;
    return { esito };
  }

  _indicizzaNota(rel, src, st, hash, idPrecedente) {
    const db = this.db;
    const a = analizzaNota(src, rel);
    const metadati = Object.entries(a.frontmatter)
      .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v)).join('\n');
    const parole = (a.corpo.match(/\S+/g) || []).length;
    const valori = [a.titolo, a.nomeFile, JSON.stringify(a.alias), JSON.stringify(a.tag),
      JSON.stringify(a.intestazioni), JSON.stringify(a.frontmatter), st.mtimeMs, st.size, hash, parole,
      new Date().toISOString()];

    let id = idPrecedente;
    if (id) {
      db.prepare(`UPDATE note SET titolo=?, nome_file=?, alias=?, tag=?, intestazioni=?, frontmatter=?,
        mtime=?, dimensione=?, hash=?, parole=?, indicizzata_il=? WHERE id=?`).run(...valori, id);
      db.prepare('DELETE FROM note_fts WHERE rowid = ?').run(id);
      db.prepare('DELETE FROM link WHERE sorgente = ?').run(id);
    } else {
      id = Number(db.prepare(`INSERT INTO note (percorso, titolo, nome_file, alias, tag, intestazioni, frontmatter,
        mtime, dimensione, hash, parole, indicizzata_il) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(rel, ...valori).lastInsertRowid);
    }
    db.prepare(`INSERT INTO note_fts (rowid, titolo, percorso, alias, tag, intestazioni, metadati, testo)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, a.titolo, rel, a.alias.join(' '), a.tag.join(' '),
      a.intestazioni.join('\n'), metadati, a.corpo);
    const insL = db.prepare('INSERT INTO link VALUES (?, ?, ?, ?)');
    for (const l of a.link) insL.run(id, l.destinazione, l.sezione, l.embed ? 1 : 0);

    // Sezioni: posizione e hash nel file originale; nel full text il testo della sezione con il titolo della nota.
    if (idPrecedente) this._cancellaSezioni(id);
    const insS = db.prepare('INSERT INTO sezioni (nota, ordine, livello, titolo, percorso_sezione, inizio, fine, hash) VALUES (?,?,?,?,?,?,?,?)');
    const insF = db.prepare('INSERT INTO sezioni_fts (rowid, titolo_nota, sezione, testo) VALUES (?,?,?,?)');
    sezioniNota(src).forEach((s, i) => {
      const testo = src.slice(s.inizio, s.fine);
      const sid = Number(insS.run(id, i, s.livello, s.titolo, s.percorso, s.inizio, s.fine, crypto.createHash('sha1').update(testo).digest('hex')).lastInsertRowid);
      insF.run(sid, a.titolo + ' ' + rel, s.percorso, testo);
    });
  }

  _cancellaSezioni(notaId) {
    for (const s of this.db.prepare('SELECT id FROM sezioni WHERE nota = ?').all(notaId)) this.db.prepare('DELETE FROM sezioni_fts WHERE rowid = ?').run(s.id);
    this.db.prepare('DELETE FROM sezioni WHERE nota = ?').run(notaId);
  }

  // Risolve un wikilink come fa Obsidian: percorso esatto, poi nome del file, poi alias.
  risolviLink(destinazione, daPercorso) {
    const db = this.db;
    let d = destinazione.replace(/\\/g, '/').replace(/^\.\//, '');
    if (daPercorso && (d.startsWith('../') || d.includes('/'))) {
      const base = path.posix.dirname(daPercorso);
      const rel = path.posix.normalize(path.posix.join(base, d));
      if (!rel.startsWith('..')) {
        for (const c of [rel, rel + '.md']) {
          const r = db.prepare('SELECT percorso FROM note WHERE percorso = ?').get(c);
          if (r) return { tipo: 'nota', percorso: r.percorso };
        }
      }
    }
    for (const c of [d, d + '.md']) {
      const r = db.prepare('SELECT percorso FROM note WHERE percorso = ? COLLATE NOCASE').get(c);
      if (r) return { tipo: 'nota', percorso: r.percorso };
      const al = db.prepare('SELECT percorso FROM allegati WHERE percorso = ? COLLATE NOCASE').get(c);
      if (al) return { tipo: 'allegato', percorso: al.percorso };
    }
    const nome = d.split('/').pop().replace(/\.md$/i, '');
    const r = db.prepare('SELECT percorso FROM note WHERE nome_file = ? COLLATE NOCASE ORDER BY length(percorso) LIMIT 1').get(nome);
    if (r) return { tipo: 'nota', percorso: r.percorso };
    const al = db.prepare("SELECT percorso FROM allegati WHERE percorso = ? COLLATE NOCASE OR percorso LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT 1")
      .get(d, '%/' + d.split('/').pop().replace(/[%_\\]/g, '\\$&'));
    if (al) return { tipo: 'allegato', percorso: al.percorso };
    for (const n of db.prepare("SELECT percorso, alias FROM note WHERE alias != '[]'").all()) {
      if (JSON.parse(n.alias).some(x => x.toLowerCase() === nome.toLowerCase())) return { tipo: 'nota', percorso: n.percorso };
    }
    return null;
  }

  stato() {
    this.apri();
    const n = this.db.prepare('SELECT count(*) c FROM note').get().c;
    const a = this.db.prepare('SELECT count(*) c FROM allegati').get().c;
    const u = this.db.prepare("SELECT valore FROM meta WHERE chiave = 'ultimo_aggiornamento'").get();
    const stato = { note: n, allegati: a, ultimoAggiornamento: u ? u.valore : null, fileIndice: config.indexFile };
    if (this.recuperato) stato.indiceCorrottoMessoDaParte = this.recuperato;
    return stato;
  }

  chiudi() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

module.exports = { Indice };
