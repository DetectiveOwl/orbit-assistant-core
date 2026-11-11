'use strict';
// Persistenza applicativa di Orbit: cronologia chat, richieste diagnostiche, chiamate AI, preferenze.
// Sta fuori dal vault (ORBIT_DATA_DIR) ed e separata dalla memoria personale a lungo termine (le note Obsidian).
// Nelle tabelle di diagnostica non finisce il testo delle richieste: solo metadati tecnici.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = 3;

function nuovoId(prefisso) { return prefisso + '_' + crypto.randomBytes(8).toString('hex'); }
function oggi(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

class Storage {
  // `file` puo essere ':memory:' nei test.
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this._migra();
  }

  _migra() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (chiave TEXT PRIMARY KEY, valore TEXT)');
    const r = this.db.prepare("SELECT valore FROM meta WHERE chiave = 'schema'").get();
    if (r && Number(r.valore) >= SCHEMA) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversazioni (
        id TEXT PRIMARY KEY, titolo TEXT NOT NULL, creata INTEGER NOT NULL, aggiornata INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messaggi (
        id TEXT PRIMARY KEY, conversazione TEXT NOT NULL REFERENCES conversazioni(id) ON DELETE CASCADE,
        ruolo TEXT NOT NULL, contenuto TEXT NOT NULL, creato INTEGER NOT NULL,
        richiesta TEXT, verifica TEXT, fonti TEXT);
      CREATE INDEX IF NOT EXISTS idx_messaggi_conv ON messaggi(conversazione, creato);
      CREATE TABLE IF NOT EXISTS richieste (
        id TEXT PRIMARY KEY, conversazione TEXT, creata INTEGER NOT NULL, giorno TEXT NOT NULL,
        categoria TEXT, modello_iniziale TEXT, tier_iniziale TEXT, esito TEXT, verifica TEXT,
        tentativi INTEGER DEFAULT 0, escalation INTEGER DEFAULT 0, chiamate INTEGER DEFAULT 0,
        token_in INTEGER, token_out INTEGER, costo REAL, latenza_ms INTEGER,
        motivo_escalation TEXT, errore TEXT, piano TEXT, eventi TEXT);
      CREATE INDEX IF NOT EXISTS idx_richieste_creata ON richieste(creata);
      CREATE TABLE IF NOT EXISTS chiamate (
        id INTEGER PRIMARY KEY AUTOINCREMENT, richiesta TEXT NOT NULL, giorno TEXT NOT NULL, creata INTEGER NOT NULL,
        ruolo TEXT NOT NULL, tentativo INTEGER, tier TEXT, modello TEXT, esito TEXT,
        token_in INTEGER, token_out INTEGER, latenza_ms INTEGER, costo REAL, errore TEXT);
      CREATE INDEX IF NOT EXISTS idx_chiamate_richiesta ON chiamate(richiesta);
      CREATE INDEX IF NOT EXISTS idx_chiamate_giorno ON chiamate(giorno);
      CREATE TABLE IF NOT EXISTS preferenze (chiave TEXT PRIMARY KEY, valore TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, creato INTEGER NOT NULL, richiesta TEXT, integrazione TEXT, azione TEXT, livello TEXT,
        esito TEXT NOT NULL, dettaglio TEXT, impronta TEXT, durata_ms INTEGER);
      CREATE INDEX IF NOT EXISTS idx_audit_creato ON audit(creato);
    `);
    // Migrazione dalla versione 1: nuove colonne per provider, stato del processo e fonte dei token.
    for (const col of ['provider TEXT', 'codice_uscita INTEGER', 'token_fonte TEXT']) {
      try { this.db.exec('ALTER TABLE chiamate ADD COLUMN ' + col); } catch (e) { /* gia presente */ }
    }
    this.db.prepare("INSERT OR REPLACE INTO meta (chiave, valore) VALUES ('schema', ?)").run(String(SCHEMA));
  }

  chiudi() { try { this.db.close(); } catch (e) { /* gia chiuso */ } }

  // ---- conversazioni e messaggi ----
  creaConversazione(titolo = 'Nuova conversazione') {
    const id = nuovoId('conv'), t = Date.now();
    this.db.prepare('INSERT INTO conversazioni (id, titolo, creata, aggiornata) VALUES (?,?,?,?)').run(id, titolo, t, t);
    return this.conversazione(id);
  }
  conversazione(id) {
    return this.db.prepare('SELECT id, titolo, creata, aggiornata FROM conversazioni WHERE id = ?').get(id) || null;
  }
  elencaConversazioni(limite = 100) {
    return this.db.prepare(`SELECT c.id, c.titolo, c.creata, c.aggiornata, (SELECT COUNT(*) FROM messaggi m WHERE m.conversazione = c.id) AS messaggi
      FROM conversazioni c ORDER BY c.aggiornata DESC LIMIT ?`).all(limite);
  }
  rinomina(id, titolo) { this.db.prepare('UPDATE conversazioni SET titolo = ? WHERE id = ?').run(String(titolo).slice(0, 120), id); }
  eliminaConversazione(id) { return this.db.prepare('DELETE FROM conversazioni WHERE id = ?').run(id).changes > 0; }

  aggiungiMessaggio({ conversazione, ruolo, contenuto, richiesta = null, verifica = null, fonti = null }) {
    const id = nuovoId('msg'), t = Date.now();
    this.db.prepare('INSERT INTO messaggi (id, conversazione, ruolo, contenuto, creato, richiesta, verifica, fonti) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, conversazione, ruolo, contenuto, t, richiesta, verifica, fonti ? JSON.stringify(fonti) : null);
    this.db.prepare('UPDATE conversazioni SET aggiornata = ? WHERE id = ?').run(t, conversazione);
    return id;
  }
  messaggi(conversazione, limite = 500) {
    const righe = this.db.prepare(`SELECT id, ruolo, contenuto, creato, richiesta, verifica, fonti,
      (SELECT json_extract(r.piano, '$.verifica.modo') FROM richieste r WHERE r.id = messaggi.richiesta) AS verificaModo FROM messaggi
      WHERE conversazione = ? ORDER BY creato DESC, rowid DESC LIMIT ?`).all(conversazione, limite).reverse();
    return righe.map(r => Object.assign({}, r, { fonti: r.fonti ? JSON.parse(r.fonti) : [] }));
  }

  // ---- richieste e chiamate (diagnostica) ----
  salvaRichiesta(r) {
    this.db.prepare(`INSERT OR REPLACE INTO richieste (id, conversazione, creata, giorno, categoria, modello_iniziale, tier_iniziale, esito, verifica,
      tentativi, escalation, chiamate, token_in, token_out, costo, latenza_ms, motivo_escalation, errore, piano, eventi)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      r.id, r.conversazione || null, r.creata, r.giorno, r.categoria || null, r.modelloIniziale || null, r.tierIniziale || null,
      r.esito || null, r.verifica || null, r.tentativi || 0, r.escalation || 0, r.chiamate || 0,
      r.tokenIn ?? null, r.tokenOut ?? null, r.costo ?? null, r.latenzaMs ?? null,
      r.motivoEscalation || null, r.errore || null, r.piano ? JSON.stringify(r.piano) : null, r.eventi ? JSON.stringify(r.eventi) : null);
  }
  richiesta(id) {
    const r = this.db.prepare('SELECT * FROM richieste WHERE id = ?').get(id);
    if (!r) return null;
    return Object.assign({}, r, { piano: r.piano ? JSON.parse(r.piano) : null, eventi: r.eventi ? JSON.parse(r.eventi) : [],
      chiamateDettaglio: this.chiamate(id) });
  }
  elencaRichieste(limite = 50) {
    return this.db.prepare(`SELECT id, conversazione, creata, categoria, modello_iniziale, tier_iniziale, esito, verifica, tentativi, escalation,
      chiamate, token_in, token_out, costo, latenza_ms, motivo_escalation, errore FROM richieste ORDER BY creata DESC LIMIT ?`).all(limite);
  }
  registraChiamata(c) {
    this.db.prepare(`INSERT INTO chiamate (richiesta, giorno, creata, ruolo, tentativo, tier, modello, esito, token_in, token_out, latenza_ms, costo, errore, provider, codice_uscita, token_fonte)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.richiesta, c.giorno, c.creata, c.ruolo, c.tentativo ?? null, c.tier || null,
      c.modello || null, c.esito, c.tokenIn ?? null, c.tokenOut ?? null, c.latenzaMs ?? null, c.costo ?? null, c.errore || null,
      c.provider || null, c.codiceUscita ?? null, c.tokenFonte || null);
  }
  // Audit delle operazioni rilevanti: solo metadati, mai contenuti ne valori dei parametri.
  registraAudit(a) {
    this.db.prepare('INSERT INTO audit (creato, richiesta, integrazione, azione, livello, esito, dettaglio, impronta, durata_ms) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.creato, a.richiesta || null, a.integrazione || null, a.azione || null, a.livello || null, a.esito, a.dettaglio || '', a.impronta || null, a.durataMs ?? null);
  }
  elencaAudit(limite = 50) {
    return this.db.prepare('SELECT id, creato, richiesta, integrazione, azione, livello, esito, dettaglio, impronta, durata_ms FROM audit ORDER BY id DESC LIMIT ?').all(limite);
  }
  // Limiti dell'abbonamento osservati oggi (chiamate rifiutate perche il limite era raggiunto).
  limitiRilevati(giorno = oggi()) {
    return this.db.prepare("SELECT COUNT(*) AS n, MAX(creata) AS ultimo FROM chiamate WHERE giorno = ? AND errore = 'LIMITE_ABBONAMENTO'").get(giorno);
  }
  contaChiamateDal(ms) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM chiamate WHERE creata >= ?').get(ms).n;
  }
  chiamate(richiesta) {
    return this.db.prepare('SELECT * FROM chiamate WHERE richiesta = ? ORDER BY id').all(richiesta);
  }
  totaleGiorno(giorno = oggi()) {
    return this.db.prepare(`SELECT COUNT(*) AS chiamate, COALESCE(SUM(token_in),0) AS token_in, COALESCE(SUM(token_out),0) AS token_out,
      SUM(costo) AS costo FROM chiamate WHERE giorno = ?`).get(giorno);
  }
  // SQLite segnala scritture locali e da altre connessioni: nessun TTL o totale obsoleto.
  async totaleStorico() {
    const versione = () => this.db.prepare('SELECT total_changes() AS n').get().n + ':' + this.db.prepare('PRAGMA data_version').get().data_version + ':' + this.db.isTransaction;
    const v = versione();
    if (this.db.isTransaction === false && this._storico?.versione === v) return { ...this._storico.totale };
    if (!this._storicoInCorso) {
      this._storicoInCorso = (async () => {
        const blocco = this.db.prepare(`SELECT COUNT(*) AS chiamate, COUNT(costo) AS costiNoti,
          COALESCE(SUM(costo),0) AS costo, MIN(creata) AS dal, MAX(creata) AS al, MAX(id) AS ultimo
          FROM (SELECT id, costo, creata FROM chiamate WHERE id > ? ORDER BY id LIMIT 2048)`);
        for (let prova = 0; prova < 3; prova++) {
          const prima = versione(), totale = { chiamate: 0, costiNoti: 0, costiMancanti: 0, costo: 0, dal: null, al: null };
          let ultimo = 0;
          for (;;) {
            // Letture limitate sulla chiave primaria; la chat puo proseguire tra un blocco e l'altro.
            await new Promise(setImmediate);
            const b = blocco.get(ultimo);
            if (!b.chiamate) break;
            totale.chiamate += b.chiamate; totale.costiNoti += b.costiNoti; totale.costo += b.costo;
            totale.dal = totale.dal == null ? b.dal : Math.min(totale.dal, b.dal);
            totale.al = totale.al == null ? b.al : Math.max(totale.al, b.al); ultimo = b.ultimo;
          }
          if (prima !== versione()) continue;
          totale.costiMancanti = totale.chiamate - totale.costiNoti;
          if (totale.chiamate && !totale.costiNoti) totale.costo = null;
          // Non conservare letture non confermate: un rollback deve poter ripristinare il totale.
          if (this.db.isTransaction === false) this._storico = { versione: prima, totale };
          return totale;
        }
        throw new Error('Storico in aggiornamento: riprova tra poco');
      })().finally(() => { this._storicoInCorso = null; });
    }
    return { ...await this._storicoInCorso };
  }
  // Statistiche aggregate per la pagina di diagnostica.
  riepilogo(giorni = 7) {
    const da = oggi(new Date(Date.now() - giorni * 86400000));
    const per = this.db.prepare(`SELECT tier, modello, COUNT(*) AS chiamate, COALESCE(SUM(token_in),0) AS token_in,
      COALESCE(SUM(token_out),0) AS token_out, SUM(costo) AS costo, AVG(latenza_ms) AS latenza_media
      FROM chiamate WHERE giorno >= ? AND esito = 'ok' GROUP BY tier, modello ORDER BY tier`).all(da);
    const req = this.db.prepare(`SELECT COUNT(*) AS richieste, COALESCE(SUM(escalation),0) AS escalation,
      SUM(CASE WHEN verifica = 'PASS' THEN 1 ELSE 0 END) AS verificate FROM richieste WHERE giorno >= ?`).get(da);
    return { dal: da, perModello: per, richieste: req };
  }

  // ---- preferenze applicative ----
  preferenza(chiave, def = null) {
    const r = this.db.prepare('SELECT valore FROM preferenze WHERE chiave = ?').get(chiave);
    return r ? r.valore : def;
  }
  preferenze() {
    const out = {};
    for (const r of this.db.prepare('SELECT chiave, valore FROM preferenze').all()) out[r.chiave] = r.valore;
    return out;
  }
  impostaPreferenza(chiave, valore) {
    this.db.prepare('INSERT OR REPLACE INTO preferenze (chiave, valore) VALUES (?, ?)').run(chiave, String(valore));
  }
}

module.exports = { Storage, nuovoId, oggi };
