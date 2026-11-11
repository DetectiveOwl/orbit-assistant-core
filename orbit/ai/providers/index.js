'use strict';
// Creazione dei provider abilitati da configurazione (ORBIT_PROVIDERS). Oggi l'unico adapter esistente e claude-code.
const { ClaudeCodeProvider } = require('./claude-code');
const { ClaudePersistentProvider } = require('./claude-persistente');
const { metodiMancanti } = require('./contract');

const ADAPTER = {
  // Modalita scelta in UN solo punto (ORBIT_CLAUDE_MODALITA): persistente (predefinita: processi pronti) o tradizionale (claude -p a ogni chiamata, per il rollback); vedi docs/PERFORMANCE.md
  'claude-code': settings => {
    const base = { bin: settings.claudeBin, cwd: settings.ccCwd };
    const m = settings.claudePersistente;
    if (!m || m.modalita !== 'persistente') return new ClaudeCodeProvider(base);
    const p = new ClaudePersistentProvider(Object.assign(base, { riuso: m.riuso, poolMax: m.pool, prewarm: m.prewarm, ttlInattivoMs: m.ttlMs, webPersistente: m.web }));
    if (m.avvioAutomatico !== false) p.avvia();      // pool pronto all'avvio di Orbit, dopo la verifica del login (ORBIT_CLAUDE_AVVIO_AUTOMATICO=0 per non farlo)
    return p;
  }
};

function creaProvider(settings) {
  const nome = (settings.providers && settings.providers[0]) || 'claude-code';
  const f = ADAPTER[nome];
  if (!f) throw new Error('Provider non supportato: ' + nome + '. Disponibili: ' + Object.keys(ADAPTER).join(', '));
  const p = f(settings);
  const mancanti = metodiMancanti(p);
  if (mancanti.length) throw new Error('Il provider ' + nome + ' non rispetta il contratto: mancano ' + mancanti.join(', '));
  return p;
}

module.exports = { creaProvider, ADAPTER };
