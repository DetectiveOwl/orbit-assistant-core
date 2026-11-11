'use strict';
// Strumenti comuni dei test: provider finto programmabile, settings di prova, app in memoria.
const config = require('../config');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { OrbitError } = require('../ai/errors');

// Provider finto: `copione` e una funzione ({model, system, messages, ruolo}) -> risposta | eccezione.
// Riconosce il verificatore dal prompt di sistema, cosi i test scrivono regole per "produttore" e "verificatore".
class MockProvider {
  constructor({ produttore, verificatore, modelli } = {}) {
    this.produttore = produttore || (() => ({ text: 'Risposta di prova.' }));
    this.verificatore = verificatore || (() => ({ status: 'PASS', reason: 'ok', failed_criteria: [], evidence: [], correction_instructions: '', confidence: 0.9 }));
    this.modelli = modelli || [
      { id: 'mock-haiku-1', nome: 'Mock Haiku', creato: '2025-01-01T00:00:00Z' },
      { id: 'mock-sonnet-1', nome: 'Mock Sonnet', creato: '2025-01-01T00:00:00Z' },
      { id: 'mock-opus-1', nome: 'Mock Opus', creato: '2025-01-01T00:00:00Z' }
    ];
    this.chiamate = [];
    this.id = 'mock';
  }
  executeTask(req) { return this.complete(req); }
  cancelExecution() { return false; }
  async healthCheck() { return { ok: true, errore: null, dettagli: {} }; }
  async discoverCapabilities() { return { id: 'mock' }; }
  async listAvailableModels() { return this.modelli; }
  async complete(req) {
    const verifica = /verificatore di qualita/.test(req.system || '');
    const ruolo = verifica ? 'verificatore' : 'produttore';
    this.chiamate.push({ ruolo, model: req.model, system: req.system, messages: req.messages, maxTokens: req.maxTokens });
    if (req.signal && req.signal.aborted) throw new OrbitError('ABORTED', 'x', { fatal: true });
    const n = this.chiamate.filter(c => c.ruolo === ruolo).length;
    const r = await (verifica ? this.verificatore : this.produttore)({ model: req.model, n, system: req.system, messages: req.messages, req });
    if (typeof r === 'string') return this._ok(r, req);
    if (r && r.text !== undefined) return this._ok(r.text, req, r);
    return this._ok(JSON.stringify(r), req);
  }
  _ok(text, req, extra = {}) {
    return {
      text, stopReason: extra.stopReason || 'end_turn', model: req.model, latencyMs: 5,
      usage: extra.usage || { inputTokens: 100, outputTokens: 50 }, costoEquivalente: extra.costoEquivalente
    };
  }
  async listModels() { return this.modelli; }
  conteggio(ruolo) { return this.chiamate.filter(c => c.ruolo === ruolo).length; }
}

function settingsProva(extra = {}) {
  const { settings } = config.carica({
    envProcesso: Object.assign({
      ORBIT_AI_VERIFY: 'sempre', ORBIT_ENV_FILE: 'C:\\inesistente\\.env', ORBIT_DATA_DIR: require('os').tmpdir() + '\\orbit-test-dati',
      ORBIT_MODEL_HAIKU: 'mock-haiku-1', ORBIT_MODEL_SONNET: 'mock-sonnet-1', ORBIT_MODEL_OPUS: 'mock-opus-1'
    }, extra.env || {}),
    envFile: 'C:\\inesistente\\.env'
  });
  if (extra.limiti) Object.assign(settings.limiti, extra.limiti);
  if (extra.settings) Object.assign(settings, extra.settings);
  return settings;
}

function appProva({ provider, settings, memoria = null } = {}) {
  const s = settings || settingsProva();
  const p = provider || new MockProvider();
  return creaApp({ settings: s, provider: p, storage: new Storage(':memory:'), memoria, attendiFn: () => Promise.resolve() });
}

async function chiedi(app, messaggio, extra = {}) {
  const eventi = [];
  const r = await app.orchestrator.elabora(Object.assign({ messaggio, onEvent: e => eventi.push(e) }, extra));
  return { r, eventi, tipi: eventi.map(e => e.tipo) };
}

module.exports = { MockProvider, settingsProva, appProva, chiedi };
