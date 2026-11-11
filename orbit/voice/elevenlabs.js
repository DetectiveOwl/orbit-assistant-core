'use strict';
// Sintesi vocale espressiva con ElevenLabs (piano a pagamento, unico servizio a pagamento di Orbit) e ripiego automatico su Piper locale.
// La chiave API (ELEVENLABS_API_KEY) viene letta dall'ambiente o dai file .env fuori dal repository (%LOCALAPPDATA%\Orbit\.env, privato/orbit.env):
// non compare mai in codice, log, stato dell'interfaccia o Git. Il testo di ogni frase va al servizio cloud; l'audio resta in memoria e non viene salvato.
const BASE = 'https://api.elevenlabs.io/v1';
const MAX_CARATTERI = 700;
const TIMEOUT_MS = 15000;
const QUOTA_VALIDA_MS = 5 * 60 * 1000;
const MODELLI_CON_LINGUA = /^eleven_(flash|turbo)_v2_5$/;   // solo questi accettano language_code

class ElevenLabsTTS {
  // chiave: funzione che restituisce la chiave (riletta a ogni uso, cosi si puo aggiungere senza riavviare). fetchFn/orologio iniettabili nei test.
  constructor({ chiave, voceId, modello = 'eleven_v3', tettoMese = 0, fetchFn, orologio = Date.now, log = null }) {
    this.chiave = chiave; this.voceId = voceId; this.modello = modello; this.tettoMese = tettoMese;
    this.fetchFn = fetchFn || ((...a) => fetch(...a)); this.orologio = orologio; this.log = log;
    this.sospesaFino = 0; this.motivo = null;
    this.quota = null;                                  // { usati, limite, ts } dall'API (la chiamata non consuma crediti)
  }

  pronta() { return !!(this.chiave() && this.voceId && this.orologio() >= this.sospesaFino); }
  stato() { return { configurata: !!(this.chiave() && this.voceId), pronta: this.pronta(), modello: this.modello, sospesaPer: this.orologio() < this.sospesaFino ? this.motivo : null, quota: this.quota ? { usati: this.quota.usati, limite: this.quota.limite } : null }; }
  _sospendi(ms, motivo) { this.sospesaFino = this.orologio() + ms; this.motivo = motivo; if (this.log) this.log.warn('ElevenLabs sospeso: ' + motivo); }
  _tetto() { const l = this.quota ? this.quota.limite : 0; return this.tettoMese > 0 ? (l > 0 ? Math.min(l, this.tettoMese) : this.tettoMese) : l; }

  async _fetch(url, init) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try { return await this.fetchFn(url, Object.assign({ signal: ctl.signal }, init)); } finally { clearTimeout(t); }
  }

  // Crediti del mese dal servizio (nessun consumo). Un errore qui non blocca la sintesi: vale l'ultimo dato noto.
  async aggiornaQuota(forza = false) {
    if (!this.chiave() || (!forza && this.quota && this.orologio() - this.quota.ts < QUOTA_VALIDA_MS)) return this.quota;
    try {
      const r = await this._fetch(BASE + '/user/subscription', { headers: { 'xi-api-key': this.chiave() } });
      if (r.ok) { const j = await r.json(); this.quota = { usati: Number(j.character_count) || 0, limite: Number(j.character_limit) || 0, ts: this.orologio() }; }
    } catch (e) { /* si va avanti con l'ultimo dato */ }
    return this.quota;
  }

  // Restituisce un Buffer MP3. velocita: 1 normale (ElevenLabs accetta 0.7-1.2).
  async sintetizza(testo, { velocita = 1 } = {}) {
    const pulito = String(testo || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CARATTERI);
    if (!pulito) throw new Error('Testo vuoto.');
    if (!this.pronta()) throw new Error('ElevenLabs non e disponibile' + (this.motivo && this.orologio() < this.sospesaFino ? ' (' + this.motivo + ')' : '.'));
    await this.aggiornaQuota();
    const tetto = this._tetto();
    if (tetto > 0 && this.quota.usati + pulito.length > tetto) { this._sospendi(60 * 60 * 1000, 'crediti mensili esauriti o oltre il tetto'); throw new Error('Crediti ElevenLabs esauriti.'); }
    const richiesta = Math.max(0.7, Number(velocita) || 1), api = Math.min(1.2, richiesta);
    const corpo = { text: pulito, model_id: this.modello, voice_settings: { stability: this.modello === 'eleven_v3' ? 0.5 : 0.4, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true } };
    if (api !== 1) corpo.voice_settings.speed = api;   // velocita 1 = predefinita del modello (v3 non e stato provato con speed)
    if (MODELLI_CON_LINGUA.test(this.modello)) corpo.language_code = 'it';
    let r;
    try {
      r = await this._fetch(BASE + '/text-to-speech/' + encodeURIComponent(this.voceId) + '?output_format=mp3_44100_128', { method: 'POST', headers: { 'xi-api-key': this.chiave(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(corpo) });
    } catch (e) { this._sospendi(30 * 1000, 'rete non raggiungibile'); throw new Error('ElevenLabs non risponde.'); }
    if (!r.ok) {
      const dettaglio = await r.text().catch(() => '');
      const esaurito = /quota_exceeded/.test(dettaglio);
      if (esaurito) this._sospendi(60 * 60 * 1000, 'crediti esauriti');
      else if (r.status === 401 || r.status === 403) this._sospendi(10 * 60 * 1000, 'chiave non accettata');
      else if (r.status === 429) this._sospendi(60 * 1000, 'troppe richieste');
      else if (r.status >= 500) this._sospendi(30 * 1000, 'servizio in errore');
      throw new Error('ElevenLabs ha risposto ' + r.status + (esaurito ? ' (crediti esauriti)' : ''));   // il corpo non si riporta: potrebbe citare la chiave
    }
    const mp3 = Buffer.from(await r.arrayBuffer());
    if (this.quota) this.quota.usati += pulito.length;
    mp3.residua = Math.round(richiesta / api * 100) / 100;      // oltre 1,2x l'API non arriva: il resto lo applica il browser in riproduzione
    return mp3;
  }
}

// Motore predefinito ElevenLabs, riserva automatica Piper: manca la chiave, crediti finiti, rete assente o errore del servizio.
class VoceTTS {
  constructor({ eleven, piper, log = null }) { this.eleven = eleven; this.piper = piper; this.log = log; }
  disponibile() { return !!(this.eleven && this.eleven.pronta()) || this.piper.disponibile(); }
  stato() {
    const p = this.piper.stato();
    if (this.eleven && this.eleven.pronta()) return { disponibile: true, voce: 'ElevenLabs', motore: 'ElevenLabs (cloud)', ripiego: p.disponibile ? p.voce : null };
    return Object.assign({}, p, { disponibile: this.disponibile(), ripiego: true, elevenlabs: this.eleven ? this.eleven.stato() : null });
  }
  scalda() { if (this.eleven) this.eleven.aggiornaQuota().catch(() => {}); if (!(this.eleven && this.eleven.pronta()) && this.piper.scalda) this.piper.scalda(); }
  async sintetizza(testo, opz) {
    if (this.eleven && this.eleven.pronta()) {
      try { const b = await this.eleven.sintetizza(testo, opz); b.tipo = 'audio/mpeg'; return b; }
      catch (e) { if (this.log) this.log.warn('Voce ElevenLabs non riuscita, uso Piper: ' + e.message); if (!this.piper.disponibile()) throw e; }
    }
    return this.piper.sintetizza(testo, opz);
  }
  chiudi() { this.piper.chiudi(); }
}

module.exports = { ElevenLabsTTS, VoceTTS };
