'use strict';
// Permission Manager: decide se un'operazione e consentita, richiede conferma o e negata, e gestisce le conferme.
// Gira nel server: le regole sono applicate al momento dell'esecuzione, non solo nell'interfaccia.
//
// Livelli di rischio di un'azione (dichiarati dallo strumento, mai dal modello):
//   lettura      consultare dati             predefinito: consentita se l'integrazione e abilitata
//   bozza        preparare senza effetti     predefinito: consentita
//   crea         creare qualcosa di nuovo    predefinito: conferma (puo diventare "consenti" solo per scelta dell'utente)
//   modifica     cambiare dati esistenti     SEMPRE conferma (o negata): non puo diventare "consenti"
//   irreversibile  spostare, sovrascrivere, eliminare, inviare, condividere: SEMPRE conferma (o negata)
//
// Una conferma vale per UNA operazione con QUEI parametri, una volta sola, per pochi minuti: non diventa mai un'autorizzazione generale.
// Il modello non ha accesso a questo modulo: gli strumenti ricevono solo { richiesta, signal }.
const crypto = require('crypto');

// amplia: aggiungere a una nota esistente SENZA cambiare il testo che c'e (backup prima, verifica dopo). E l'unico modo in cui una
// nota esistente puo cambiare senza conferma, e solo se l'utente lo sceglie: per default chiede conferma come "crea".
const LIVELLI = ['lettura', 'bozza', 'crea', 'amplia', 'modifica', 'irreversibile'];
const DECISIONI = ['consenti', 'conferma', 'nega'];
const PREDEFINITO = { lettura: 'consenti', bozza: 'consenti', crea: 'conferma', amplia: 'conferma', modifica: 'conferma', irreversibile: 'conferma' };
const AMMESSE = { lettura: DECISIONI, bozza: DECISIONI, crea: DECISIONI, amplia: DECISIONI, modifica: ['conferma', 'nega'], irreversibile: ['conferma', 'nega'] };
const SCADENZA_CONFERMA_MS = 5 * 60 * 1000;

// Serializzazione stabile (chiavi ordinate) per calcolare l'impronta di un'operazione.
function stabile(v) {
  if (Array.isArray(v)) return '[' + v.map(stabile).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stabile(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function impronta(integrazione, strumento, params) {
  return crypto.createHash('sha256').update(stabile([integrazione, strumento, params])).digest('hex');
}

class PermissionManager {
  constructor({ storage, audit, orologio = Date.now, scadenzaMs = SCADENZA_CONFERMA_MS }) {
    this.storage = storage; this.audit = audit; this.ora = orologio; this.scadenzaMs = scadenzaMs;
    this.pendenti = new Map();      // id -> conferma in attesa o decisa
  }

  // ---- configurazione (cambia SOLO tramite l'interfaccia dell'utente, mai tramite strumenti o modello) ----
  _leggi() { try { return JSON.parse(this.storage.preferenza('permessi', '{}')) || {}; } catch (e) { return {}; } }
  _scrivi(p) { this.storage.impostaPreferenza('permessi', JSON.stringify(p)); }

  stato(integrazione) {
    const p = this._leggi()[integrazione] || {};
    const livelli = {};
    for (const l of LIVELLI) livelli[l] = (p.livelli && AMMESSE[l].includes(p.livelli[l])) ? p.livelli[l] : PREDEFINITO[l];
    return { abilitata: p.abilitata === true, livelli };
  }
  impostaAbilitata(integrazione, abilitata) {
    const tutto = this._leggi(); tutto[integrazione] = Object.assign({}, tutto[integrazione], { abilitata: !!abilitata }); this._scrivi(tutto);
    this.audit.registra({ integrazione, azione: abilitata ? 'abilita' : 'disabilita', esito: 'configurazione', dettaglio: 'integrazione ' + (abilitata ? 'abilitata' : 'disabilitata') });
  }
  impostaLivello(integrazione, livello, decisione) {
    if (!LIVELLI.includes(livello)) throw new Error('Livello sconosciuto: ' + livello);
    if (!AMMESSE[livello].includes(decisione)) throw new Error('Per le azioni di tipo "' + livello + '" la conferma non si puo togliere: valori ammessi ' + AMMESSE[livello].join(', ') + '.');
    const tutto = this._leggi(); const p = tutto[integrazione] = Object.assign({}, tutto[integrazione]);
    p.livelli = Object.assign({}, p.livelli, { [livello]: decisione }); this._scrivi(tutto);
    this.audit.registra({ integrazione, azione: 'permesso', livello, esito: 'configurazione', dettaglio: livello + ' = ' + decisione });
  }

  // ---- decisione ----
  valuta(integrazione, livello) {
    const s = this.stato(integrazione);
    if (!s.abilitata) return { decisione: 'nega', motivo: 'integrazione_disabilitata' };
    if (!LIVELLI.includes(livello)) return { decisione: 'nega', motivo: 'livello_sconosciuto' };
    const d = s.livelli[livello];
    return { decisione: d, motivo: d === 'nega' ? 'negata_dalla_policy' : d === 'consenti' ? 'consentita_dalla_policy' : 'serve_conferma' };
  }

  // ---- conferme ----
  richiedi({ integrazione, strumento, livello, descrizione, destinazione, conseguenze, params, richiesta }) {
    const id = 'cnf_' + crypto.randomBytes(9).toString('hex');
    const c = { id, integrazione, strumento, livello, descrizione, destinazione: destinazione || '', conseguenze: conseguenze || '', richiesta: richiesta || null,
      impronta: impronta(integrazione, strumento, params), creata: this.ora(), scade: this.ora() + this.scadenzaMs, stato: 'in_attesa', usata: false, _attese: [] };
    this.pendenti.set(id, c);
    this.audit.registra({ richiesta, integrazione, azione: strumento, livello, esito: 'conferma_richiesta', dettaglio: descrizione, impronta: c.impronta });
    c._timer = setTimeout(() => this._scadenza(c), this.scadenzaMs); if (c._timer.unref) c._timer.unref();
    return this._pubblica(c);
  }
  _pubblica(c) { return { id: c.id, integrazione: c.integrazione, strumento: c.strumento, livello: c.livello, descrizione: c.descrizione, destinazione: c.destinazione, conseguenze: c.conseguenze, scade: c.scade, stato: c.stato }; }
  _scadenza(c) { if (c.stato === 'in_attesa') { c.stato = 'scaduta'; this._chiudi(c, 'scaduta'); } }
  _chiudi(c, esito) {
    clearTimeout(c._timer);
    this.audit.registra({ richiesta: c.richiesta, integrazione: c.integrazione, azione: c.strumento, livello: c.livello, esito, dettaglio: c.descrizione, impronta: c.impronta });
    for (const r of c._attese.splice(0)) r(c.stato);
  }
  elenca() {
    const now = this.ora();
    for (const c of this.pendenti.values()) if (c.stato === 'in_attesa' && now >= c.scade) this._scadenza(c);
    return [...this.pendenti.values()].filter(c => c.stato === 'in_attesa').map(c => this._pubblica(c));
  }
  // Risposta dell'utente (arriva solo dal canale HTTP dell'interfaccia). Ritorna lo stato finale oppure null se la conferma non esiste.
  rispondi(id, approva) {
    const c = this.pendenti.get(id);
    if (!c) return null;
    if (c.stato === 'in_attesa' && this.ora() >= c.scade) this._scadenza(c);
    if (c.stato !== 'in_attesa') return c.stato;
    c.stato = approva ? 'approvata' : 'rifiutata';
    this._chiudi(c, approva ? 'confermata' : 'rifiutata');
    return c.stato;
  }
  // Attende la decisione dell'utente. Si risolve con 'approvata', 'rifiutata', 'scaduta' o 'annullata'.
  attendi(id, { signal } = {}) {
    const c = this.pendenti.get(id);
    if (!c) return Promise.resolve('sconosciuta');
    if (c.stato !== 'in_attesa') return Promise.resolve(c.stato);
    return new Promise(resolve => {
      c._attese.push(resolve);
      if (signal) signal.addEventListener('abort', () => { if (c.stato === 'in_attesa') { c.stato = 'annullata'; this._chiudi(c, 'annullata'); } }, { once: true });
    });
  }
  // Usa la conferma UNA volta, solo per la stessa operazione con gli stessi parametri e solo se non e scaduta.
  consuma(id, integrazione, strumento, params) {
    const c = this.pendenti.get(id);
    if (!c) return { ok: false, motivo: 'conferma_sconosciuta' };
    if (c.stato === 'in_attesa' && this.ora() >= c.scade) this._scadenza(c);
    if (c.usata) return { ok: false, motivo: 'conferma_gia_usata' };
    if (c.stato === 'scaduta') return { ok: false, motivo: 'conferma_scaduta' };
    if (c.stato === 'rifiutata') return { ok: false, motivo: 'conferma_rifiutata' };
    if (c.stato !== 'approvata') return { ok: false, motivo: 'conferma_non_approvata' };
    if (this.ora() >= c.scade) { c.stato = 'scaduta'; return { ok: false, motivo: 'conferma_scaduta' }; }
    if (c.integrazione !== integrazione || c.strumento !== strumento || c.impronta !== impronta(integrazione, strumento, params)) return { ok: false, motivo: 'conferma_per_altra_operazione' };
    c.usata = true;
    return { ok: true, impronta: c.impronta };
  }
  pulisci() { const now = this.ora(); for (const [id, c] of this.pendenti) if (now > c.scade + 600000) this.pendenti.delete(id); }
}

module.exports = { PermissionManager, LIVELLI, DECISIONI, PREDEFINITO, AMMESSE, impronta, stabile };
