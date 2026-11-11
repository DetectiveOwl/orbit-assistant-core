'use strict';
// Audit Logger: registra le operazioni RILEVANTI (uso di strumenti, conferme, cambi di permessi e integrazioni) con soli metadati.
// Mai il contenuto di email, documenti o note, e mai i valori dei parametri: dei parametri resta solo un'impronta (hash).
// Il dettaglio e un riassunto breve scritto dal codice dell'integrazione, ripulito da token e indirizzi.

const SEGRETI = /sk-ant-[\w-]+|ya29\.[\w.-]+|AIza[\w-]{20,}|Bearer\s+[\w.~+/=-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|(?:token|secret|password|passwd|chiave)\s*[:=]\s*\S+/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function ripulisci(testo, max = 160) {
  return String(testo == null ? '' : testo).replace(SEGRETI, '[oscurato]').replace(EMAIL, '[indirizzo]').replace(/\s+/g, ' ').trim().slice(0, max);
}

const ESITI = ['consentita', 'negata', 'conferma_richiesta', 'confermata', 'rifiutata', 'scaduta', 'completata', 'errore', 'annullata', 'configurazione'];

class AuditLogger {
  constructor({ storage, orologio = Date.now }) { this.storage = storage; this.ora = orologio; }

  // evento: { richiesta, integrazione, azione, livello, esito, dettaglio, impronta, durataMs }
  registra(evento) {
    const e = Object.assign({ richiesta: null, integrazione: null, azione: null, livello: null, dettaglio: '', impronta: null, durataMs: null }, evento);
    if (!ESITI.includes(e.esito)) e.esito = 'errore';
    try {
      this.storage.registraAudit({ creato: this.ora(), richiesta: e.richiesta, integrazione: e.integrazione, azione: e.azione, livello: e.livello,
        esito: e.esito, dettaglio: ripulisci(e.dettaglio), impronta: e.impronta ? String(e.impronta).slice(0, 16) : null, durataMs: e.durataMs });
    } catch (err) { /* l'audit non deve mai rompere l'operazione, ma un errore qui non puo passare in silenzio nei test */ if (this.suErrore) this.suErrore(err); }
  }

  elenca(limite = 50) { return this.storage.elencaAudit(Math.min(Math.max(1, limite), 500)); }
}

module.exports = { AuditLogger, ripulisci, ESITI };
