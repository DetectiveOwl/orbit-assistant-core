'use strict';
const { performance } = require('node:perf_hooks');

const FASI = new Set(['ricevuta', 'avviata', 'classificazione', 'classificata', 'contesto', 'contesto_pronto', 'retrieval_inizio', 'retrieval_fine', 'routing', 'instradata', 'strumento', 'strumento_fine', 'tentativo', 'esecuzione', 'generazione_fine', 'verifica', 'esito_verifica', 'escalation', 'tentativo_mirato', 'ritento', 'chiamata_inizio', 'chiamata_fine', 'processo_scelto', 'primo_output', 'primo_testo', 'sintesi_inizio', 'sintesi_fine', 'pronta', 'errore', 'interrotta']);
const PUNTI_UI = ['parlato_fine', 'trascrizione_fine', 'inviata', 'ricevuta', 'verificata', 'dom', 'visibile', 'completa', 'sintesi_inizio', 'audio_primo', 'audio_fine'];
const msValido = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 86400000;

function statistiche(valori) {
  const v = valori.filter(msValido).sort((a, b) => a - b), n = v.length;
  if (!n) return { campioni: 0, media: null, mediana: null, p95: null, min: null, max: null };
  return { campioni: n, media: v.reduce((a, b) => a + b, 0) / n, mediana: (v[Math.floor((n - 1) / 2)] + v[Math.floor(n / 2)]) / 2,
    p95: n >= 20 ? v[Math.ceil(n * .95) - 1] : null, min: v[0], max: v[n - 1] };
}

class PerformanceTrace {
  constructor({ attivo = true, ora = () => performance.now() } = {}) {
    this.attivo = attivo; this.ora = ora; this.tracce = new Map();
  }
  crea(id, voce = false, inizio = this.ora()) {
    if (!this.attivo) return null;
    const dati = { richiesta: id, categoria: voce ? 'voce' : 'conversazione', ok: false, eventi: [{ fase: 'ricevuta', ms: 0 }], frontend: {} };
    // shortcut: ultimi 500 turni in RAM, aggiungere persistenza solo se serve analisi tra riavvii.
    this.tracce.set(id, dati);
    if (this.tracce.size > 500) this.tracce.delete(this.tracce.keys().next().value);
    const marca = (fase, dettagli = {}) => {
      if (!FASI.has(fase) || dati.eventi.length >= 256) return;
      const e = { fase, ms: Math.max(0, this.ora() - inizio) };
      for (const k of ['chiamata', 'tentativo', 'durataMs']) if (msValido(dettagli[k])) e[k] = dettagli[k];
      if (['produttore', 'verificatore', 'strumento_web'].includes(dettagli.ruolo)) e.ruolo = dettagli.ruolo;
      if (['persistente', 'tradizionale', 'tradizionale-fallback'].includes(dettagli.modalita)) e.modalita = dettagli.modalita;
      dati.eventi.push(e);
    };
    Object.defineProperty(dati, 'marca', { value: marca });
    return { marca, dati, categoria: categoria => {
      const ordine = ['conversazione', 'memoria', 'strumenti', 'web', 'voce'];
      if (ordine.indexOf(categoria) > ordine.indexOf(dati.categoria)) dati.categoria = categoria;
    }, finisci: ok => { marca('pronta'); dati.ok = ok; } };
  }
  frontend(id, punti) {
    const dati = this.tracce.get(id);
    if (!dati || !dati.ok) return false;
    if (!punti || typeof punti !== 'object' || Array.isArray(punti) || !Object.keys(punti).length) throw new Error('Metriche non valide.');
    for (const [k, v] of Object.entries(punti)) {
      if (!PUNTI_UI.includes(k) || !msValido(v) || (k in dati.frontend && dati.frontend[k] !== v)) throw new Error('Metriche non valide.');
    }
    const uniti = { ...dati.frontend, ...punti };
    for (const catena of [PUNTI_UI.slice(0, 8), [...PUNTI_UI.slice(0, 5), ...PUNTI_UI.slice(8)]]) {
      const ordine = catena.map(k => uniti[k]).filter(v => v !== undefined);
      if (ordine.some((v, i) => i && v < ordine[i - 1])) throw new Error('Ordine dei tempi non valido.');
    }
    if (!('inviata' in uniti)) throw new Error('Ordine dei tempi non valido.');
    dati.frontend = uniti;
    return true;
  }
  riepilogo() {
    const categorie = {};
    for (const categoria of ['conversazione', 'memoria', 'strumenti', 'web', 'voce']) {
      const tracce = [...this.tracce.values()].filter(t => t.ok && t.categoria === categoria);
      const differenza = (t, a, b) => a in t.frontend && b in t.frontend ? t.frontend[b] - t.frontend[a] : null;
      categorie[categoria] = {
        backend: statistiche(tracce.map(t => t.eventi.find(e => e.fase === 'pronta')?.ms)),
        primoContenuto: statistiche(tracce.map(t => differenza(t, 'inviata', 'visibile'))),
        rispostaCompleta: statistiche(tracce.map(t => differenza(t, 'inviata', 'completa'))),
        ritardoUI: statistiche(tracce.map(t => differenza(t, 'ricevuta', 'visibile'))),
        primoAudio: statistiche(tracce.map(t => differenza(t, 'parlato_fine' in t.frontend ? 'parlato_fine' : 'inviata', 'audio_primo')))
      };
    }
    return { attivo: this.attivo, conservate: this.tracce.size, limite: 500, categorie };
  }
}
module.exports = { PerformanceTrace, statistiche, PUNTI_UI };
