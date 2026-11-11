'use strict';
// UsageTracker: registra ogni chiamata AI con i dati reali restituiti dall'API.
// Con l'abbonamento non c'e fatturazione per token. Il "costo" registrato e l'EQUIVALENTE A LISTINO API riportato da Claude Code (stima, non addebitato): serve solo a confrontare i consumi.
const { oggi } = require('../../storage/db');

class UsageTracker {
  constructor({ storage }) {
    this.storage = storage;
    this.perRichiesta = new Map();     // richiestaId -> totali in memoria
  }

  // Registra una chiamata, riuscita o no. Restituisce i dati normalizzati.
  registra({ richiesta, ruolo, tentativo, tier, modello, esito, usage, latenzaMs, errore, costoEquivalente, provider, codiceUscita }) {
    const tokenIn = usage && usage.inputTokens != null ? usage.inputTokens : null;
    const tokenOut = usage && usage.outputTokens != null ? usage.outputTokens : null;
    const costo = Number.isFinite(costoEquivalente) ? costoEquivalente : null;
    const rec = { richiesta, giorno: oggi(), creata: Date.now(), ruolo, tentativo, tier, modello, esito, tokenIn, tokenOut, latenzaMs, costo, errore: errore || null,
      provider: provider || null, codiceUscita: Number.isInteger(codiceUscita) ? codiceUscita : null,
      tokenFonte: tokenIn != null || tokenOut != null ? 'riportati' : null };     // token reali del provider; se mancano restano non disponibili, mai stimati
    try { this.storage.registraChiamata(rec); } catch (e) { /* la diagnostica non deve mai rompere la chat */ }
    const t = this.perRichiesta.get(richiesta) || { chiamate: 0, chiamateOk: 0, tokenIn: 0, tokenOut: 0, costo: 0, costoNoto: true, tokenNoti: true, latenzaMs: 0 };
    t.chiamate += 1;
    if (esito === 'ok') t.chiamateOk += 1;
    if (tokenIn == null || tokenOut == null) { if (esito === 'ok') t.tokenNoti = false; } else { t.tokenIn += tokenIn; t.tokenOut += tokenOut; }
    if (costo == null) { if (esito === 'ok') t.costoNoto = false; } else t.costo += costo;
    t.latenzaMs += latenzaMs || 0;
    this.perRichiesta.set(richiesta, t);
    return rec;
  }

  totaliRichiesta(richiesta) {
    const t = this.perRichiesta.get(richiesta);
    if (!t) return { chiamate: 0, chiamateOk: 0, tokenIn: 0, tokenOut: 0, token: 0, costo: null, costoStimato: true, latenzaMs: 0 };
    return {
      chiamate: t.chiamate, chiamateOk: t.chiamateOk, tokenIn: t.tokenIn, tokenOut: t.tokenOut, token: t.tokenIn + t.tokenOut,
      costo: t.costoNoto && t.chiamateOk > 0 ? t.costo : null, costoStimato: true, latenzaMs: t.latenzaMs
    };
  }

  chiudiRichiesta(richiesta) { this.perRichiesta.delete(richiesta); }

  // Contatore di consumo: blocca Orbit PRIMA di consumare i limiti dell'abbonamento. Conta le chiamate reali a Claude Code.
  consumoSuperato(limiti) {
    const ora = this.storage.contaChiamateDal(Date.now() - 3600000);
    if (ora >= limiti.chiamatePerOra) return 'Orbit ha gia fatto ' + ora + ' chiamate a Claude nell\'ultima ora (limite ' + limiti.chiamatePerOra + ', ORBIT_MAX_CALLS_PER_HOUR): mi fermo per non consumare i limiti del tuo abbonamento. Riprova piu tardi.';
    const giorno = this.storage.totaleGiorno().chiamate;
    if (giorno >= limiti.chiamatePerGiorno) return 'Orbit ha gia fatto ' + giorno + ' chiamate a Claude oggi (limite ' + limiti.chiamatePerGiorno + ', ORBIT_MAX_CALLS_PER_DAY): mi fermo per oggi.';
    return null;
  }

  // Controllo dei limiti giornalieri. Restituisce null se si puo procedere, altrimenti il motivo.
  limiteGiornalieroSuperato(limiti) {
    const t = this.storage.totaleGiorno();
    if (limiti.limiteGiornalieroToken > 0 && (t.token_in + t.token_out) >= limiti.limiteGiornalieroToken) {
      return 'Limite giornaliero di token raggiunto (' + limiti.limiteGiornalieroToken + '). Si azzera domani, oppure alzalo con ORBIT_DAILY_TOKEN_LIMIT.';
    }
    return null;
  }
}

module.exports = { UsageTracker };
