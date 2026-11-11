'use strict';
// ModelRegistry: associa i tre livelli (haiku, sonnet, opus) a identificativi reali.
// Gli identificativi vengono da ORBIT_MODEL_* oppure, se manca, dall'elenco dei modelli del tuo account
// (il piu recente della famiglia). Nulla e scritto a mano nel codice e ogni scelta e verificata sull'elenco.
const { TIERS } = require('../../config');

const FAMIGLIE = { haiku: /haiku/i, sonnet: /sonnet/i, opus: /opus/i };

class ModelRegistry {
  constructor({ modelli, autodetect, provider }) {
    this.configurati = modelli;
    this.autodetect = autodetect;
    this.provider = provider;
    this.stato = {};
    for (const t of TIERS) this.stato[t] = { id: modelli[t] || null, origine: modelli[t] ? 'env' : null, disponibile: null, nota: modelli[t] ? 'non ancora verificato' : 'non configurato' };
    this.elenco = null;
    this.errore = null;
  }

  // Interroga l'API per l'elenco dei modelli. Non lancia: se fallisce, i modelli configurati restano "non verificati".
  async inizializza({ signal } = {}) {
    this.errore = null;
    try {
      this.elenco = await this.provider.listModels({ signal });
    } catch (e) {
      this.elenco = null;
      this.errore = e.message || String(e);
    }
    // Con Claude Code l'elenco e solo di alias: non puo smentire un nome completo scelto da te, che si verifica alla prima chiamata.
    const ids = this.elenco && !this.provider.elencoIndicativo ? new Set(this.elenco.map(m => m.id)) : null;
    for (const t of TIERS) {
      const s = this.stato[t];
      if (s.id) {
        if (ids) {
          s.disponibile = ids.has(s.id);
          s.nota = s.disponibile ? 'verificato sull\'account' : 'non presente tra i modelli dell\'account';
        } else { s.disponibile = null; s.nota = this.provider.elencoIndicativo ? 'non verificabile in anticipo: si prova alla prima chiamata' : 'non verificabile: ' + this.errore; }
      } else if (this.autodetect && this.elenco) {
        const candidati = this.elenco.filter(m => FAMIGLIE[t].test(m.id)).sort((a, b) => (b.creato || '').localeCompare(a.creato || '') || b.id.localeCompare(a.id));
        if (candidati.length) {
          Object.assign(s, { id: candidati[0].id, origine: 'autodetect', disponibile: true, nota: this.provider.elencoIndicativo ? 'alias di Claude Code: la disponibilita nel tuo piano si prova alla prima chiamata' : 'scelto dall\'elenco dell\'account (il piu recente della famiglia)' });
        } else { s.nota = 'nessun modello ' + t + ' tra quelli dell\'account'; s.disponibile = false; }
      } else if (!this.elenco) {
        s.nota = 'non configurato e non rilevabile: ' + (this.errore || 'elenco non disponibile');
      }
    }
    if (this.provider.verificaModelli) this.applicaVerifica(this.provider.verificaModelli);
    return this.riepilogo();
  }

  // Applica il risultato di una verifica reale (chiamata minima per ogni alias): [{ id, verificato, disponibile, verificatoIl }].
  applicaVerifica(risultati) {
    if (!Array.isArray(risultati)) return;
    for (const t of TIERS) {
      const s = this.stato[t];
      const r = risultati.find(x => x.id === s.id);
      if (!r || !r.verificato) continue;
      s.disponibile = r.disponibile;
      s.verificatoIl = r.verificatoIl || null;
      s.nota = r.disponibile ? 'provato con una chiamata reale' + (r.verificatoIl ? ' il ' + r.verificatoIl.slice(0, 16).replace('T', ' ') : '') : 'rifiutato da Claude Code: non disponibile nel tuo piano';
    }
  }

  // Id del modello per un livello, oppure null se non utilizzabile (non configurato o noto come non disponibile).
  modello(tier) {
    const s = this.stato[tier];
    return s && s.id && s.disponibile !== false ? s.id : null;
  }

  disponibili() { return TIERS.filter(t => this.modello(t)); }

  segnalaNonDisponibile(tier) {
    const s = this.stato[tier];
    if (s) { s.disponibile = false; s.nota = 'rifiutato dall\'API durante l\'uso'; }
  }

  riepilogo() {
    const out = {};
    for (const t of TIERS) out[t] = Object.assign({}, this.stato[t]);
    return { tiers: out, elencoAccount: this.elenco ? this.elenco.length : null, errore: this.errore };
  }
}

module.exports = { ModelRegistry };
