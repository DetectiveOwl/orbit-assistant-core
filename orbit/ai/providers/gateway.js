'use strict';
// ProviderGateway: tutte le chiamate AI di Orbit passano da qui. Applica budget, timeout, retry
// con backoff sugli errori transitori (rate limit, sovraccarico) e registra ogni chiamata nel tracker.
// Nessun agente o verificatore parla con il provider senza passare dal gateway.
const { OrbitError, errori } = require('../errors');
const { tierAmmessi, modelloAmmesso, famigliaModello, escludiModello } = require('../router/modelli-ammessi');
const { performance } = require('node:perf_hooks');

const CARATTERI_PER_TOKEN = 3.5;   // stima prudente per l'italiano, usata solo PRIMA della chiamata per il budget
const stimaToken = testo => Math.ceil(String(testo || '').length / CARATTERI_PER_TOKEN);

function stimaInput(system, messages) {
  return stimaToken(system) + messages.reduce((a, m) => a + stimaToken(m.content) + 4, 0);
}

function attendi(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(errori.aborted());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(errori.aborted()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

class ProviderGateway {
  constructor({ provider, tracker, limiti, attendiFn, performanceTrace, registry }) {
    this.provider = provider;
    this.registry = registry;
    this.tracker = tracker;
    this.limiti = limiti;
    this.attendi = attendiFn || attendi;
    this.n = 0;
    this.performanceTrace = performanceTrace;
  }

  // run: { id, signal, scadenza (timestamp ms) }. Restituisce { text, usage, stopReason, model, latencyMs }.
  async chiama({ run, ruolo, tentativo, tier, model, system, messages, maxTokens, ruoloBudget = true, strumentiWeb = false }) {
    const trace = run.trace || this.performanceTrace?.tracce.get(run.id);
    const L = this.limiti;
    const stimaIn = stimaInput(system, messages);
    const tot = this.tracker.totaliRichiesta(run.id);
    const residuoRichiesta = L.budgetTokenRichiesta - tot.token;
    const tettoTentativo = Math.min(L.budgetTokenTentativo, residuoRichiesta);
    if (stimaIn >= tettoTentativo) {
      throw errori.budget('Il budget di token non basta per questa chiamata (servono circa ' + stimaIn + ' token in ingresso, ne restano ' + Math.max(0, tettoTentativo) + ').');
    }
    const lim = this.tracker.consumoSuperato(L);
    if (lim) throw errori.limiteConsumo(lim);
    const maxOut = Math.max(16, Math.min(maxTokens, tettoTentativo - stimaIn));

    let tentativiApi = 0;
    for (;;) {
      if (run.signal && run.signal.aborted) throw errori.aborted();
      if (!tierAmmessi(run.piano, undefined, run.modelliIndisponibili).includes(tier) || run.identificatoriIndisponibili?.has(model)) throw errori.noModel();
      if (!modelloAmmesso(run.piano, tier, model, this.provider)) throw new OrbitError('MODEL_RISK', 'Modello non ammesso o famiglia non verificabile dal piano di rischio.', { fatal: true });
      if (this.registry && this.registry.modello(tier) !== model) throw errori.modelNotFound(model);
      const resto = run.scadenza - Date.now();
      if (resto <= 0) throw new OrbitError('TIMEOUT', 'La richiesta ha superato il tempo massimo.', { fatal: true });
      const t0 = performance.now();
      const chiamata = ++this.n;
      const tempi = { chiamata, ruolo, tentativo };
      trace?.marca('chiamata_inizio', tempi);
      let rispostaProvider = null;
      try {
        const r = await this.provider.executeTask({
          executionId: run.id + '_' + chiamata, model, system, messages, maxTokens: maxOut, signal: run.signal,
          timeoutMs: Math.min(L.timeoutChiamataMs, resto), strumentiWeb,
          onPerformance: trace ? fase => trace.marca(fase, tempi) : undefined
        });
        rispostaProvider = r;
        const restituito = Object.hasOwn(r, 'modelReported') ? r.modelReported : r.model || null;
        const dichiarati = [...new Set([restituito, ...(r.modelsReported || [])].filter(Boolean))];
        if (run.piano?.rischio === 'high' && dichiarati.some(id => !modelloAmmesso(run.piano, tier, id, this.provider))) {
          throw new OrbitError('MODEL_RISK', 'Il provider ha restituito un modello incompatibile o non verificabile.', { fatal: true });
        }
        r.modelloSicurezza = { tierPrevisto: tier, richiesto: model, restituito, famigliaRichiesta: famigliaModello(model, this.provider), famigliaRestituita: famigliaModello(restituito, this.provider) };
        const durataMs = performance.now() - t0;
        trace?.marca('chiamata_fine', { ...tempi, durataMs, modalita: r.modalita });
        this.tracker.registra({ richiesta: run.id, ruolo, tentativo, tier, modello: r.model || model, esito: 'ok', usage: r.usage, latenzaMs: durataMs, costoEquivalente: r.costoEquivalente, provider: r.provider, codiceUscita: r.processo && r.processo.codiceUscita });
        return r;
      } catch (err) {
        const oe = err instanceof OrbitError ? err : new OrbitError('INTERNAL', 'Errore interno nella chiamata AI: ' + (err && err.message), {});
        const durataMs = performance.now() - t0;
        trace?.marca('chiamata_fine', { ...tempi, durataMs });
        this.tracker.registra({ richiesta: run.id, ruolo, tentativo, tier, modello: rispostaProvider?.modelReported || rispostaProvider?.model || model, esito: oe.code === 'ABORTED' ? 'interrotta' : 'errore:' + oe.code, usage: rispostaProvider?.usage || null, latenzaMs: durataMs, errore: oe.code, provider: this.provider.id, codiceUscita: oe.codiceUscita });
        if (oe.code === 'MODEL_NOT_FOUND') {
          escludiModello(run, model, tier, this.registry);
          // Il contratto low conserva l'indisponibilita globale; high conserva le esclusioni del singolo run.
          if (run.piano?.rischio !== 'high' && this.registry) {
            for (const t of this.registry.disponibili()) if (this.registry.modello(t) === model) this.registry.segnalaNonDisponibile(t);
          }
          throw oe;
        }
        if (!oe.retryable || tentativiApi >= L.maxRetryApi) throw oe;
        tentativiApi += 1;
        const pausa = Math.min(oe.retryAfterMs || (600 * 2 ** (tentativiApi - 1)), 8000, Math.max(0, run.scadenza - Date.now() - 1000));
        if (run.onRetry) run.onRetry({ codice: oe.code, tentativoApi: tentativiApi, attesaMs: pausa, tier, model });
        else trace?.marca('ritento', tempi);
        await this.attendi(pausa, run.signal);
      }
    }
  }
}

module.exports = { ProviderGateway, stimaToken, stimaInput };
