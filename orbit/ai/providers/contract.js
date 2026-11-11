'use strict';
// Contratto comune dei provider di esecuzione dei modelli (ModelExecutionProvider).
// Il router e l'orchestratore dipendono SOLO da questo contratto, mai da uno specifico programma CLI.
// Oggi esiste un solo adapter reale (claude-code). Aggiungerne un altro significa implementare questi metodi e
// registrarlo in index.js: nessun'altra parte di Orbit deve cambiare.
//
//   id                                        identificativo del provider (es. 'claude-code')
//   discoverCapabilities({ probe })           scheda delle capacita: eseguibile, autenticazione, modelli, modalita, limiti
//   listAvailableModels({ probe, signal })    modelli selezionabili; con probe=true ogni modello e provato con una chiamata minima
//   executeTask(request)                      { executionId, model, system, messages, maxTokens, signal, timeoutMs }
//                                             -> { text, usage, stopReason, model, latencyMs, costoEquivalente, provider, processo }
//   modelRequested/modelReported/modelsReported distinguono richiesta e dati effettivamente esposti; modelReported e null se assente.
//   cancelExecution(executionId)              ferma un'esecuzione in corso, true se esisteva
//   healthCheck({ forza, signal })            { ok, errore, dettagli }: strumento presente e autenticato come richiesto

const METODI = ['discoverCapabilities', 'listAvailableModels', 'executeTask', 'cancelExecution', 'healthCheck'];

// Elenco dei metodi mancanti (vuoto = il provider rispetta il contratto).
function metodiMancanti(provider) {
  const m = METODI.filter(n => typeof provider[n] !== 'function');
  if (!provider.id) m.push('id');
  return m;
}

module.exports = { METODI, metodiMancanti };
