'use strict';
// Integration Manager e Tool Registry. Ogni integrazione (documenti, Obsidian, web, Google...) dichiara i propri strumenti;
// TUTTA l'esecuzione passa da IntegrationManager.esegui, che nell'ordine:
//   1. verifica che integrazione e strumento esistano e che l'integrazione sia abilitata e configurata;
//   2. valida i parametri contro lo schema dichiarato (campi sconosciuti respinti);
//   3. chiede al Permission Manager se l'operazione e consentita, da confermare o negata;
//   4. se serve, ottiene la conferma specifica dell'utente (una per operazione e per parametri);
//   5. esegue con timeout e annullamento, isolando gli errori;
//   6. scrive la riga di audit (solo metadati).
// Il contenuto restituito da uno strumento e un DATO: chi lo riceve lo tratta come non attendibile.
//
// Contratto di un'integrazione:
//   { id, nome, descrizione,
//     prerequisiti?: async () => ({ ok, messaggio }),                         // es. cartella configurata, account collegato
//     strumenti: { nome: { livello, descrizione, schema, timeoutMs?, descriviConferma?(params), esegui: async (params, ctx) => risultato } } }
//   schema: { campo: { tipo: 'string'|'number'|'boolean'|'enum'|'lista', richiesto?, max?, min?, valori? } }
const { LIVELLI, impronta } = require('./permessi');
const { ripulisci } = require('./audit');
const { categoriaAutonomia } = require('../ai/autonomia');

const TIMEOUT_PREDEFINITO_MS = 30000;
const MAX_RISULTATO = 400000;

// Valida e normalizza i parametri. Restituisce { ok, valori } oppure { ok:false, errore }.
function valida(schema, params) {
  if (params === undefined || params === null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, errore: 'I parametri devono essere un oggetto.' };
  const valori = {};
  for (const k of Object.keys(params)) if (!Object.prototype.hasOwnProperty.call(schema, k)) return { ok: false, errore: 'Parametro non previsto: ' + k };
  for (const [nome, def] of Object.entries(schema)) {
    const v = params[nome];
    if (v === undefined || v === null || v === '') { if (def.richiesto) return { ok: false, errore: 'Parametro obbligatorio mancante: ' + nome }; continue; }
    switch (def.tipo) {
      case 'string':
        if (typeof v !== 'string' || v.includes('\u0000')) return { ok: false, errore: nome + ' deve essere un testo.' };
        if (v.length > (def.max || 2000)) return { ok: false, errore: nome + ' e troppo lungo (massimo ' + (def.max || 2000) + ' caratteri).' };
        valori[nome] = v; break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, errore: nome + ' deve essere un numero.' };
        if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) return { ok: false, errore: nome + ' fuori intervallo.' };
        valori[nome] = v; break;
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, errore: nome + ' deve essere vero o falso.' };
        valori[nome] = v; break;
      case 'enum':
        if (!(def.valori || []).includes(v)) return { ok: false, errore: nome + ' non valido: valori ammessi ' + (def.valori || []).join(', ') + '.' };
        valori[nome] = v; break;
      case 'lista':
        if (!Array.isArray(v) || v.length > (def.max || 50) || v.some(x => typeof x !== 'string' || x.length > 500 || x.includes('\u0000'))) return { ok: false, errore: nome + ' deve essere un elenco di testi (massimo ' + (def.max || 50) + ').' };
        valori[nome] = v.slice(); break;
      default: return { ok: false, errore: 'Schema non valido per ' + nome };
    }
  }
  return { ok: true, valori };
}

function conTimeout(promessa, ms, signal, alTimeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(Object.assign(new Error('Operazione scaduta dopo ' + Math.round(ms / 1000) + ' secondi.' + (alTimeout ? ' Esito possibilmente sconosciuto: verifica lo stato prima di riprovare.' : '')), { codice: 'TIMEOUT' })); alTimeout?.(); }, ms);
    const onAbort = () => reject(Object.assign(new Error('Operazione annullata.'), { codice: 'ANNULLATA' }));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    promessa.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

class IntegrationManager {
  constructor({ permessi, audit, orologio = Date.now }) { this.permessi = permessi; this.audit = audit; this.ora = orologio; this.integrazioni = new Map(); }

  registra(integr) {
    if (!integr || !/^[a-z][a-z0-9-]{1,30}$/.test(integr.id || '') || !integr.strumenti || typeof integr.strumenti !== 'object') throw new Error('Integrazione non valida.');
    for (const [nome, s] of Object.entries(integr.strumenti)) {
      if (!LIVELLI.includes(s.livello)) throw new Error('Livello non valido per ' + integr.id + '.' + nome);
      if (typeof s.esegui !== 'function') throw new Error('Strumento senza esecuzione: ' + integr.id + '.' + nome);
      if (!s.schema || typeof s.schema !== 'object') throw new Error('Strumento senza schema dei parametri: ' + integr.id + '.' + nome);
    }
    this.integrazioni.set(integr.id, integr);
  }

  // Stato per l'interfaccia: abilitata, configurata (prerequisiti), strumenti con il livello e la decisione corrente.
  async elenca() {
    const out = [];
    for (const i of this.integrazioni.values()) {
      const st = this.permessi.stato(i.id);
      let pre = { ok: true, messaggio: '' };
      if (i.prerequisiti) { try { pre = await i.prerequisiti(); } catch (e) { pre = { ok: false, messaggio: 'Controllo non riuscito: ' + e.message }; } }
      out.push({ id: i.id, nome: i.nome || i.id, descrizione: i.descrizione || '', abilitata: st.abilitata, configurata: !!pre.ok, messaggio: pre.messaggio || '', livelli: st.livelli,
        strumenti: Object.entries(i.strumenti).map(([n, s]) => ({ nome: n, livello: s.livello, descrizione: s.descrizione || '', decisione: this.permessi.valuta(i.id, s.livello).decisione })) });
    }
    return out;
  }

  // Descrizione degli strumenti per i pianificatori (mai per concedere permessi).
  catalogo() {
    const c = [];
    for (const i of this.integrazioni.values()) {
      if (!this.permessi.stato(i.id).abilitata) continue;
      for (const [n, s] of Object.entries(i.strumenti)) c.push({ integrazione: i.id, strumento: n, livello: s.livello, descrizione: s.descrizione || '', schema: s.schema });
    }
    return c;
  }

  // Restituisce esiti degli strumenti; le violazioni del vincolo modelli high interrompono invece la richiesta.
  esegui(integrazioneId, nomeStrumento, params, opzioni = {}) {
    return this._esegui(integrazioneId, nomeStrumento, params, opzioni);
  }

  eseguiWeb(params, run, opzioni = {}) {
    const sicurezza = run && Object.freeze({
      id: run.id, scadenza: run.scadenza, piano: Object.freeze({ rischio: run.piano?.rischio }),
      modelliIndisponibili: run.modelliIndisponibili, identificatoriIndisponibili: run.identificatoriIndisponibili,
      trace: run.trace, onRetry: run.onRetry
    });
    return this._esegui('web', 'cerca_web', params, opzioni, sicurezza);
  }

  async _esegui(integrazioneId, nomeStrumento, params, { richiesta = null, conversazione = null, signal, confermaId = null, onConferma } = {}, sicurezzaWeb) {
    const t0 = this.ora();
    const traccia = (esito, dettaglio, extra = {}) => this.audit.registra(Object.assign({ richiesta, integrazione: integrazioneId, azione: nomeStrumento, livello: livello, esito, dettaglio, durataMs: this.ora() - t0 }, extra));
    let livello = null;
    const integr = this.integrazioni.get(integrazioneId);
    const strumento = integr && Object.prototype.hasOwnProperty.call(integr.strumenti, nomeStrumento) ? integr.strumenti[nomeStrumento] : null;
    if (!strumento) { traccia('negata', 'strumento sconosciuto'); return { ok: false, codice: 'SCONOSCIUTO', errore: 'Strumento sconosciuto: ' + integrazioneId + '.' + nomeStrumento }; }
    livello = strumento.livello;

    // 1. Integrazione abilitata e configurata (un'integrazione spenta o rotta non compromette il resto).
    if (!this.permessi.stato(integrazioneId).abilitata) { traccia('negata', 'integrazione disabilitata'); return { ok: false, codice: 'DISABILITATA', errore: 'L\'integrazione ' + (integr.nome || integr.id) + ' e disabilitata.' }; }
    if (integr.prerequisiti) {
      let pre; try { pre = await integr.prerequisiti(); } catch (e) { pre = { ok: false, messaggio: e.message }; }
      if (!pre.ok) { traccia('negata', 'non configurata'); return { ok: false, codice: 'NON_CONFIGURATA', errore: 'L\'integrazione ' + (integr.nome || integr.id) + ' non e configurata: ' + (pre.messaggio || 'mancano dei prerequisiti.') }; }
    }
    // 2. Parametri validi.
    const v = valida(strumento.schema, params);
    if (!v.ok) { traccia('negata', 'parametri non validi'); return { ok: false, codice: 'PARAMETRI', errore: v.errore }; }
    const valori = v.valori;
    const imp = impronta(integrazioneId, nomeStrumento, valori);
    // 3. Permesso, applicato qui, lato esecuzione. Uno strumento puo dichiarare un livello piu basso per i soli parametri dentro un
    // ambito autorizzato dall'host (livelloPer, es. bozze nell'area bozze): il modello non lo sceglie e fuori dall'ambito resta quello base.
    const base = livello;
    livello = strumento.livelloPer ? strumento.livelloPer(valori) || base : base;
    // Il livello piu basso vale solo se consente e se il livello base non e negato: l'area non scavalca un "nega" e non e piu restrittiva del resto.
    if (livello !== base && (this.permessi.valuta(integrazioneId, livello).decisione !== 'consenti' || this.permessi.valuta(integrazioneId, base).decisione === 'nega')) livello = base;
    const dec = this.permessi.valuta(integrazioneId, livello);
    const categoria = categoriaAutonomia(livello, dec.decisione, livello !== base);
    if (dec.decisione === 'nega') { traccia('negata', dec.motivo, { impronta: imp }); return { ok: false, codice: 'NEGATA', errore: 'L\'operazione non e consentita dalle impostazioni (' + livello + ').' }; }
    let confermata = false;
    if (dec.decisione === 'conferma') {
      if (confermaId) {
        const c = this.permessi.consuma(confermaId, integrazioneId, nomeStrumento, valori);
        if (!c.ok) { traccia('negata', c.motivo, { impronta: imp }); return { ok: false, codice: 'CONFERMA_NON_VALIDA', errore: 'La conferma non e valida per questa operazione (' + c.motivo.replace(/_/g, ' ') + ').' }; }
        confermata = true;
      } else {
        const d = strumento.descriviConferma ? strumento.descriviConferma(valori) : {};
        const info = this.permessi.richiedi({ integrazione: integrazioneId, strumento: nomeStrumento, livello, params: valori, richiesta,
          descrizione: d.descrizione || (strumento.descrizione || nomeStrumento), destinazione: d.destinazione, conseguenze: d.conseguenze });
        if (!onConferma) return { ok: false, codice: 'CONFERMA_RICHIESTA', errore: 'Serve la conferma dell\'utente.', confermaId: info.id, conferma: info };
        onConferma(info);
        const esito = await this.permessi.attendi(info.id, { signal });
        if (esito !== 'approvata') {
          return { ok: false, codice: esito === 'rifiutata' ? 'CONFERMA_RIFIUTATA' : esito === 'scaduta' ? 'CONFERMA_SCADUTA' : 'ANNULLATA', errore: esito === 'rifiutata' ? 'Hai rifiutato l\'operazione.' : esito === 'scaduta' ? 'La conferma e scaduta: l\'operazione non e stata eseguita.' : 'Operazione annullata.' };
        }
        const c = this.permessi.consuma(info.id, integrazioneId, nomeStrumento, valori);
        if (!c.ok) return { ok: false, codice: 'CONFERMA_NON_VALIDA', errore: 'La conferma non e piu valida (' + c.motivo.replace(/_/g, ' ') + ').' };
        confermata = true;
      }
    }
    // 4. Esecuzione con timeout e annullamento, errori isolati.
    if (!confermata) traccia('consentita', 'avvio', { impronta: imp });
    // Strumenti che scrivono (abortaAlTimeout): allo scadere il timeout annulla anche lo strumento, che non puo proseguire con un consenso tardivo.
    const tmo = strumento.abortaAlTimeout ? new AbortController() : null;
    if (tmo) signal = signal ? AbortSignal.any([signal, tmo.signal]) : tmo.signal;
    try {
      const risultato = await conTimeout(Promise.resolve().then(() => sicurezzaWeb
        ? strumento.esegui(valori, { richiesta, signal }, sicurezzaWeb)
        : strumento.esegui(valori, strumento.conversazione ? { richiesta, conversazione, signal } : { richiesta, signal })), strumento.timeoutMs || TIMEOUT_PREDEFINITO_MS, signal, tmo && (() => tmo.abort()));
      const dim = JSON.stringify(risultato === undefined ? null : risultato).length;
      if (dim > MAX_RISULTATO) { traccia('errore', 'risultato troppo grande', { impronta: imp }); return { ok: false, codice: 'RISULTATO_TROPPO_GRANDE', errore: 'Il risultato supera il limite consentito.' }; }
      traccia('completata', 'ok', { impronta: imp });
      // Strumenti che possono scrivere pur dichiarando un livello piu basso (es. Smart Inbox con autorizzazione persistente): l'applicazione reale ha un proprio evento.
      for (const ev of (strumento.eventiAudit?.(risultato) || [])) traccia(ev.esito, ev.dettaglio, { azione: ev.azione, livello: ev.livello, impronta: imp });
      return { ok: true, risultato, categoria: confermata ? 'C' : categoria };
    } catch (e) {
      const codice = e && e.codice === 'TIMEOUT' ? 'TIMEOUT' : e && e.codice === 'ANNULLATA' ? 'ANNULLATA' : 'ERRORE';
      traccia(codice === 'ANNULLATA' ? 'annullata' : 'errore', (codice === 'ERRORE' ? 'errore dello strumento' : codice.toLowerCase()) + (tmo && codice !== 'ERRORE' ? ': esito indeterminato' : ''), { impronta: imp });
      if (sicurezzaWeb?.piano?.rischio === 'high' && ['MODEL_RISK', 'NO_MODEL'].includes(e.code)) throw e;
      return { ok: false, codice, errore: codice === 'ERRORE' ? 'Lo strumento ha restituito un errore: ' + ripulisci(e && e.message || e, 200) : e.message };
    }
  }
}

module.exports = { IntegrationManager, valida, LIVELLI };
