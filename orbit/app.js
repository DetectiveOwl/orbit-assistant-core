'use strict';
// Composizione dei moduli di Orbit. Tutte le dipendenze sono iniettabili, cosi i test usano provider e storage finti.
const path = require('path');
const { creaProvider } = require('./ai/providers');
const { ProviderGateway } = require('./ai/providers/gateway');
const { ModelRegistry } = require('./ai/router/models');
const { AgentExecutor } = require('./ai/agents/executor');
const { QualityGate } = require('./ai/quality/gate');
const { EscalationPolicy } = require('./ai/escalation/policy');
const { UsageTracker } = require('./ai/usage/tracker');
const { Storage } = require('./storage/db');
const { PerformanceTrace } = require('./performance');
const { tierPiuVicino } = require('./ai/router/router');
const { OrbitOrchestrator } = require('./orchestrator');
const { PiperTTS } = require('./voice/piper');
const { ElevenLabsTTS, VoceTTS } = require('./voice/elevenlabs');
const profilo = require('../memoria/profilo');
const { creaVoceLocale } = require('./voice/voce-locale');
const log = require('./log');
const { AuditLogger } = require('./integrations/audit');
const { PermissionManager } = require('./integrations/permessi');
const { IntegrationManager } = require('./integrations/registry');
const { creaIntegrazioneDocumenti } = require('./integrations/documenti');
const { creaIntegrazioneObsidian } = require('./integrations/obsidian');
const { creaIntegrazioneSmartInbox } = require('./integrations/smartinbox');
const { creaIntegrazioneWeb } = require('./integrations/web');
const { GoogleAuth } = require('./integrations/google/oauth');
const { dpapi } = require('./integrations/google/cifratura');
const { creaIntegrazioneGoogle } = require('./integrations/google');

function creaApp({ settings, problemi = [], provider, storage, memoria = null, attendiFn, tts, voce, orologio, cifratura, fetchFn, smartInbox }) {
  require('./config').verificaPercorsi(settings);
  provider = provider || creaProvider(settings);
  storage = storage || new Storage(path.join(settings.dataDir, 'orbit.sqlite'));
  const tracker = new UsageTracker({ storage });
  const performanceTrace = new PerformanceTrace({ attivo: settings.performanceTrace !== false });
  const registry = new ModelRegistry({ modelli: settings.modelli, autodetect: settings.autodetect, provider });
  const gateway = new ProviderGateway({ provider, tracker, limiti: settings.limiti, attendiFn, performanceTrace, registry });
  const executor = new AgentExecutor({ gateway });
  const gate = new QualityGate({ gateway, modelloPerTier: (t, piano, run) => {
    const tier = tierPiuVicino(t, registry.disponibili(), piano, run.modelliIndisponibili);
    return tier ? { tier, model: registry.modello(tier) } : null;
  } });
  const policy = new EscalationPolicy({ limiti: settings.limiti });
  const audit = new AuditLogger({ storage, orologio });
  const permessi = new PermissionManager({ storage, audit, orologio });
  const integrazioni = new IntegrationManager({ permessi, audit, orologio });
  integrazioni.registra(creaIntegrazioneDocumenti({ storage }));
  integrazioni.registra(creaIntegrazioneWeb({ gateway, registry }));
  // Un solo punto OAuth per Calendar e Gmail; i segreti stanno in <dati>\google (fuori dal vault), token cifrati con DPAPI.
  const google = new GoogleAuth({ dir: path.join(settings.dataDir, 'google'), cifratura: cifratura || dpapi, fetchFn });
  integrazioni.registra(creaIntegrazioneGoogle({ auth: google, fetchFn }));
  integrazioni.registra(creaIntegrazioneObsidian({ memoria, datiDir: settings.dataDir, orologio, areaBozze: settings.areaBozze }));
  let siInteg = smartInbox;
  if (!siInteg) {
    // Uno scope non valido (o non sintetico) non deve impedire l'avvio di Orbit: l'integrazione resta spenta.
    try { siInteg = creaIntegrazioneSmartInbox({ ambito: settings.smartInbox, aree: [settings.vaultPath, settings.dataDir], orologio }); } catch (e) {
      problemi.push({ level: 'error', code: 'SMART_INBOX_AMBITO', message: 'Scope Smart Inbox rifiutato (' + (e.code || 'non valido') + '): integrazione spenta.' });
      siInteg = creaIntegrazioneSmartInbox({ orologio });
    }
  }
  integrazioni.registra(siInteg);
  const orchestrator = new OrbitOrchestrator({ settings, storage, registry, tracker, executor, gate, policy, memoria, provider, integrazioni, performanceTrace, problemiConfig: problemi });
  if (!tts) {
    const piper = new PiperTTS({ dir: path.join(settings.dataDir, 'tts') });
    const t = settings.tts || {};
    // La chiave si rilegge a ogni uso: se manca si riparte dai file, cosi si puo aggiungere senza riavviare Orbit.
    const chiave = () => profilo.valore('ELEVENLABS_API_KEY') || (profilo.azzeraCache(), profilo.valore('ELEVENLABS_API_KEY'));
    tts = t.motore === 'piper' ? piper : new VoceTTS({ piper, log, eleven: new ElevenLabsTTS({ chiave, voceId: t.voceId, modello: t.modello, tettoMese: t.tettoMese, fetchFn, log }) });
  }
  // Riconoscimento vocale locale (Whisper + parola Orbit): non avvia nulla qui, parte alla prima richiesta di stato dell'interfaccia.
  voce = voce || creaVoceLocale({ settings, log });
  return { google, audit, permessi, integrazioni, tts, voce, settings, problemi, provider, storage, tracker, gateway, registry, executor, gate, policy, orchestrator, memoria, performanceTrace };
}

module.exports = { creaApp };

