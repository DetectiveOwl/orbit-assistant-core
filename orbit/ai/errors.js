'use strict';
// Errori tipizzati di Orbit. Il codice decide cosa fare (riprovare, escalare, fermarsi), il messaggio e per l'utente.

class OrbitError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'OrbitError';
    this.code = code;
    this.retryable = !!extra.retryable;     // vale la pena riprovare la stessa chiamata
    this.status = extra.status || null;
    this.retryAfterMs = extra.retryAfterMs || null;
    this.fatal = !!extra.fatal;             // inutile proseguire con qualsiasi modello
  }
}

const e = {
  aborted: () => new OrbitError('ABORTED', 'Richiesta interrotta.', { fatal: true }),
  timeout: () => new OrbitError('TIMEOUT', 'Il modello non ha risposto in tempo.', { retryable: true }),
  budget: motivo => new OrbitError('BUDGET', motivo || 'Budget esaurito per questa richiesta.', { fatal: true }),
  modelNotFound: id => new OrbitError('MODEL_NOT_FOUND', 'Il modello ' + id + ' non risulta disponibile per questo account.'),
  limiteConsumo: m => new OrbitError('LIMITE_CONSUMO', m, { fatal: true }),
  noModel: () => new OrbitError('NO_MODEL', 'Nessun modello disponibile: controlla ORBIT_MODEL_HAIKU, ORBIT_MODEL_SONNET e ORBIT_MODEL_OPUS.', { fatal: true })
};

module.exports = { OrbitError, errori: e };
