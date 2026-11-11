'use strict';
// Server HTTP locale di Orbit (senza dipendenze). Ascolta solo su 127.0.0.1, serve l'interfaccia,
// espone l'API e trasmette gli eventi reali dell'orchestratore via SSE. Nessun segreto esce da qui.
const http = require('http');
const { performance } = require('node:perf_hooks');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const config = require('./config');
const log = require('./log');
const { nomeConfigurato } = require('../memoria/profilo');
const { creaApp } = require('./app');
const { cartelleAutorizzate, impostaCartelle } = require('./integrations/documenti');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATICI = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/orbit-design.css': ['orbit-design.css', 'text/css; charset=utf-8'],
  '/core-state.js': ['core-state.js', 'text/javascript; charset=utf-8'],
  '/orbit-core.js': ['orbit-core.js', 'text/javascript; charset=utf-8'],
  '/orbit-motion.js': ['orbit-motion.js', 'text/javascript; charset=utf-8'],
  '/vendor/three.module.min.js': ['vendor/three.module.min.js', 'text/javascript; charset=utf-8'],
  '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'],
  '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'],
  '/performance.js': ['performance.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PREFERENZE = { tema: ['auto', 'chiaro', 'scuro'], modalita: ['testo', 'voce', 'mista'], voceOn: ['0', '1'], voceNome: null, voceVelocita: ['0.9', '1', '1.2', '1.4', '1.5'], parolaAttivazione: ['0', '1'], movimento: ['auto', 'completo', 'ridotto'] };
const MAX_BODY = 40000;

function creaServer(app, { port }) {
  const { orchestrator, storage, registry, tracker, settings } = app;
  if (app.google) app.google.apriBrowser = url => apriUrl(url, settings.browser);
  const finestra = [];     // timestamp delle richieste di chat nell'ultimo minuto

  const hostsOk = ['localhost:' + port, '127.0.0.1:' + port];
  function origineOk(req) {
    if (!hostsOk.includes(req.headers.host)) return false;
    const o = req.headers.origin;
    return !o || hostsOk.some(h => o === 'http://' + h);
  }

  function invia(res, status, body, tipo, extra) {
    const dati = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (status === 413) { res.on('finish', () => res.req.destroy()); }
    res.writeHead(status, {
      'Content-Type': tipo || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra, ...(status === 413 ? { Connection: 'close' } : {}),
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self)'
    });
    res.end(dati);
  }

  function leggiJson(req) {
    return new Promise((resolve, reject) => {
      if (req.headers['x-orbit'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || '')) return reject({ status: 403, errore: 'Richiesta non valida.' });
      let corpo = '', troppo = false;
      req.on('data', d => { if (troppo) return; corpo += d; if (corpo.length > MAX_BODY) { troppo = true; reject({ status: 413, errore: 'Richiesta troppo grande.' }); } });
      req.on('end', () => {
        if (troppo) return;
        try { resolve(corpo ? JSON.parse(corpo) : {}); } catch (e) { reject({ status: 400, errore: 'JSON non valido.' }); }
      });
      req.on('error', () => reject({ status: 400, errore: 'Richiesta interrotta.' }));
    });
  }

  function limiteRichieste() {
    const ora = Date.now();
    while (finestra.length && ora - finestra[0] > 60000) finestra.shift();
    if (finestra.length >= settings.limiti.richiestePerMinuto) return true;
    finestra.push(ora);
    return false;
  }

  const finestraTts = [];
  function limiteTts() {
    const ora = Date.now();
    while (finestraTts.length && ora - finestraTts[0] > 60000) finestraTts.shift();
    if (finestraTts.length >= 240) return true;
    finestraTts.push(ora);
    return false;
  }

  async function sessioneAbbonamento() {
    const p = app.provider;
    if (!p || !p.verificaSessione) return { ok: true, errore: null, dettagli: {} };
    try { const r = await p.verificaSessione(); return { ok: r.ok, errore: r.errore, piano: r.dettagli && r.dettagli.piano, metodo: r.dettagli && r.dettagli.metodo, provider: r.dettagli && r.dettagli.provider }; }
    catch (e) { return { ok: false, errore: e.message }; }
  }

  async function stato() {
    try { await orchestrator.assicuraModelli(); } catch (e) { /* lo stato dei modelli riporta l'errore */ }
    let memoria = { ok: false, errore: 'Memoria non avviata.' };
    try { memoria = app.memoria ? app.memoria.controlla() : memoria; } catch (e) { memoria = { ok: false, errore: e.message }; }
    return {
      configurazione: app.problemi.map(p => ({ livello: p.level, codice: p.code, messaggio: p.message })),
      abbonamento: await sessioneAbbonamento(),
      fileEnv: settings.envFile, fileEnvTrovato: settings.envFileTrovato,
      modelli: registry.riepilogo(),
      limiti: settings.limiti, chiaviIgnorate: settings.chiaviIgnorate,
      oggi: Object.assign(storage.totaleGiorno(), { limitiRilevati: storage.limitiRilevati() }),
      memoria: { ok: memoria.ok, errore: memoria.errore || null, note: memoria.note ?? null, allegati: memoria.allegati ?? null, solaLettura: true },
      preferenze: storage.preferenze(),
      performanceTrace: app.performanceTrace?.attivo === true,
      utente: { nome: nomeConfigurato() }   // per i saluti personalizzati (ORBIT_UTENTE); null se non impostato
    };
  }

  async function gestisci(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (m === 'GET' && STATICI[p]) {
      const [file, tipo] = STATICI[p];
      try { return invia(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), tipo); } catch (e) { return invia(res, 404, { errore: 'File non trovato.' }); }
    }
    if (m === 'GET' && p === '/api/status') return invia(res, 200, await stato());
    // Voce locale (Piper): stato e sintesi. Il testo arriva dall'interfaccia e l'audio non viene mai salvato.
    if (m === 'GET' && p === '/api/tts/stato') { if (app.tts && app.tts.scalda) app.tts.scalda(); return invia(res, 200, app.tts ? app.tts.stato() : { disponibile: false }); }
    if (m === 'POST' && p === '/api/tts') {
      const j = await leggiJson(req);
      if (typeof j.testo !== 'string' || !j.testo.trim() || j.testo.length > 2000) return invia(res, 400, { errore: 'Testo non valido.' });
      if (!app.tts || !app.tts.disponibile()) return invia(res, 503, { errore: 'La voce locale non e installata: esegui node orbit/tools/installa-voce.js' });
      if (limiteTts()) return invia(res, 429, { errore: 'Troppe richieste vocali.' });
      const tracciaVoce = typeof j.richiesta === 'string' && /^req_[a-f0-9]{16}$/.test(j.richiesta) ? app.performanceTrace?.tracce.get(j.richiesta) : null;
      tracciaVoce?.marca('sintesi_inizio');
      try { const audio = await app.tts.sintetizza(j.testo, { velocita: Number(j.velocita) || 1 }); return invia(res, 200, audio, audio.tipo || 'audio/wav', audio.residua > 1 ? { 'X-Orbit-Residua': String(audio.residua) } : undefined); }
      catch (e) { log.warn('Voce locale: ' + e.message); return invia(res, 502, { errore: 'La voce locale non e riuscita: ' + e.message }); }
      finally { tracciaVoce?.marca('sintesi_fine'); }
    }
    if (m === 'GET' && p === '/api/capabilities') {
      const prov = app.provider;
      if (!prov.discoverCapabilities) return invia(res, 200, { id: 'sconosciuto' });
      return invia(res, 200, await prov.discoverCapabilities({ probe: false }));
    }
    // Verifica REALE dei modelli: una chiamata minima per ciascun alias (consuma un po' dei limiti dell'abbonamento, per questo e a richiesta).
    if (m === 'POST' && p === '/api/models/probe') {
      await readBody(req);
      const prov = app.provider;
      if (!prov.listAvailableModels) return invia(res, 400, { errore: 'Il provider non supporta la verifica dei modelli.' });
      const risultati = await prov.listAvailableModels({ probe: true });
      registry.applicaVerifica(risultati);
      storage.impostaPreferenza('verificaModelli', JSON.stringify(risultati));
      return invia(res, 200, { risultati, modelli: registry.riepilogo() });
    }
    if (m === 'POST' && p === '/api/models/refresh') {
      await readBody(req);
      orchestrator.ultimoInit = 0;
      await orchestrator.assicuraModelli();
      return invia(res, 200, registry.riepilogo());
    }

    // ---- conversazioni ----
    if (m === 'GET' && p === '/api/conversations') return invia(res, 200, storage.elencaConversazioni());
    let mm;
    if ((mm = p.match(/^\/api\/conversations\/(conv_[a-f0-9]+)$/))) {
      const id = mm[1];
      if (m === 'GET') {
        const c = storage.conversazione(id);
        return c ? invia(res, 200, Object.assign({}, c, { messaggi: storage.messaggi(id) })) : invia(res, 404, { errore: 'Conversazione non trovata.' });
      }
      if (m === 'PATCH') {
        const j = await leggiJson(req);
        if (typeof j.titolo !== 'string' || !j.titolo.trim()) return invia(res, 400, { errore: 'Titolo non valido.' });
        storage.rinomina(id, j.titolo.trim());
        return invia(res, 200, { ok: true });
      }
      if (m === 'DELETE') {
        if (req.headers['x-orbit'] !== '1') return invia(res, 403, { errore: 'Richiesta non valida.' });
        orchestrator.annulla(id);
        return storage.eliminaConversazione(id) ? invia(res, 200, { ok: true }) : invia(res, 404, { errore: 'Conversazione non trovata.' });
      }
    }

    // ---- integrazioni, permessi, conferme e audit ----
    // Questi endpoint sono il solo modo per cambiare permessi e rispondere alle conferme: arrivano dall'interfaccia dell'utente (intestazione obbligatoria),
    // mai dal modello, che non ha accesso a questi moduli.
    if (m === 'GET' && p === '/api/integrazioni') return invia(res, 200, await app.integrazioni.elenca());
    if ((mm = p.match(/^\/api\/integrazioni\/([a-z][a-z0-9-]{1,30})$/)) && m === 'PUT') {
      const j = await leggiJson(req);
      if (!app.integrazioni.integrazioni.has(mm[1])) return invia(res, 404, { errore: 'Integrazione sconosciuta.' });
      try {
        if (typeof j.abilitata === 'boolean') app.permessi.impostaAbilitata(mm[1], j.abilitata);
        if (j.livello !== undefined) app.permessi.impostaLivello(mm[1], String(j.livello), String(j.decisione));
      } catch (e) { return invia(res, 400, { errore: e.message }); }
      return invia(res, 200, (await app.integrazioni.elenca()).find(x => x.id === mm[1]));
    }
    // Cartelle dei documenti locali: le sceglie solo l'utente dall'interfaccia, mai uno strumento.
    if (m === 'GET' && p === '/api/documenti/cartelle') return invia(res, 200, { cartelle: cartelleAutorizzate(storage) });
    if (m === 'PUT' && p === '/api/documenti/cartelle') {
      const j = await leggiJson(req);
      try { const lista = impostaCartelle(storage, j.cartelle); app.audit.registra({ integrazione: 'documenti', azione: 'cartelle', esito: 'configurazione', dettaglio: lista.length + ' cartelle autorizzate' }); return invia(res, 200, { cartelle: lista }); }
      catch (e) { return invia(res, 400, { errore: e.message }); }
    }
    // Google (Calendar e Gmail, sola lettura): il collegamento si avvia solo dall'interfaccia; l'accesso avviene nella pagina di Google.
    if (m === 'GET' && p === '/api/google/stato') return invia(res, 200, await app.google.stato());
    if (m === 'POST' && p === '/api/google/collega') {
      await readBody(req);
      if (app.google.login) return invia(res, 200, { avviato: true, giaInCorso: true });
      app.google.collega().then(() => log.info('Google collegato (sola lettura).'), e => log.warn('Collegamento Google non riuscito: ' + (e.codice || 'errore')));
      return invia(res, 202, { avviato: true });
    }
    if (m === 'POST' && p === '/api/google/scollega') { await readBody(req); return invia(res, 200, await app.google.scollega()); }
    if (m === 'GET' && p === '/api/conferme') return invia(res, 200, app.permessi.elenca());
    if (m === 'POST' && (mm = p.match(/^\/api\/conferme\/(cnf_[a-f0-9]{18})$/))) {
      const j = await leggiJson(req);
      if (typeof j.approva !== 'boolean') return invia(res, 400, { errore: 'Risposta non valida.' });
      const stato = app.permessi.rispondi(mm[1], j.approva);
      return stato ? invia(res, 200, { stato }) : invia(res, 404, { errore: 'Conferma sconosciuta o scaduta.' });
    }
    if (m === 'GET' && p === '/api/audit') return invia(res, 200, app.audit.elenca(Number(url.searchParams.get('limite')) || 50));

    // ---- diagnostica ----
    if (m === 'GET' && p === '/api/performance') return invia(res, 200, app.performanceTrace.riepilogo());
    if ((mm = p.match(/^\/api\/performance\/(req_[a-f0-9]{16})$/))) {
      const trace = app.performanceTrace;
      if (m === 'GET') return invia(res, trace.tracce.has(mm[1]) ? 200 : 404, trace.tracce.get(mm[1]) || { errore: 'Traccia non disponibile.' });
      if (m === 'POST') {
        const j = await leggiJson(req);
        try { return invia(res, trace.frontend(mm[1], j.punti) ? 200 : 404, { ok: trace.tracce.has(mm[1]) }); }
        catch (e) { return invia(res, 400, { errore: 'Metriche non valide.' }); }
      }
    }
    if (m === 'GET' && p === '/api/diagnostics') {
      return invia(res, 200, { richieste: storage.elencaRichieste(Math.min(Number(url.searchParams.get('limite')) || 50, 200)), riepilogo: storage.riepilogo(7), storico: await storage.totaleStorico(), oggi: Object.assign(storage.totaleGiorno(), { limitiRilevati: storage.limitiRilevati() }) });
    }
    if (m === 'GET' && (mm = p.match(/^\/api\/diagnostics\/(req_[a-f0-9]+)$/))) {
      const r = storage.richiesta(mm[1]);
      return r ? invia(res, 200, r) : invia(res, 404, { errore: 'Richiesta non trovata.' });
    }

    // ---- preferenze ----
    if (m === 'PUT' && p === '/api/preferences') {
      const j = await leggiJson(req);
      for (const [k, v] of Object.entries(j)) {
        if (!(k in PREFERENZE)) return invia(res, 400, { errore: 'Preferenza sconosciuta: ' + k });
        const val = String(v);
        if (PREFERENZE[k] ? !PREFERENZE[k].includes(val) : val.length > 200) return invia(res, 400, { errore: 'Valore non valido per ' + k });
        storage.impostaPreferenza(k, val);
      }
      return invia(res, 200, storage.preferenze());
    }

    // ---- chat (SSE) ----
    if (m === 'POST' && p === '/api/chat/abort') {
      const j = await leggiJson(req);
      return invia(res, 200, { ok: orchestrator.annulla(String(j.conversationId || '')) });
    }
    if (m === 'POST' && p === '/api/chat') {
      const j = await leggiJson(req);
      if (typeof j.message !== 'string' || (j.conversationId != null && typeof j.conversationId !== 'string')) return invia(res, 400, { errore: 'Richiesta non valida.' });
      if (limiteRichieste()) return invia(res, 429, { errore: 'Troppe richieste in poco tempo: riprova tra qualche secondo.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP
      });
      const ctrl = new AbortController();
      let concluso = false;
      res.on('close', () => { if (!concluso) ctrl.abort(); });     // l'utente chiude o interrompe: si ferma anche il backend
      let chiuso = false;
      const manda = ev => { if (['errore', 'interrotta', 'finale'].includes(ev.tipo)) chiuso = true; if (!res.writableEnded) res.write('event: orbit\ndata: ' + JSON.stringify(ev) + '\n\n'); };
      const r = await orchestrator.elabora({ conversazioneId: j.conversationId || null, messaggio: j.message, voce: j.voice === true, ricevutaA: req.orbitRicevutaA, signal: ctrl.signal, onEvent: manda });
      if (!r.ok && !chiuso) manda({ tipo: 'errore', codice: r.codice, messaggio: r.errore });
      concluso = true;
      return res.end();
    }
    // Riconoscimento vocale locale (Whisper + parola "Orbit"): rotte in orbit/voice/voce-locale.js, vedi docs/WHISPER-STT.md.
    if (app.voce && p.startsWith('/api/voce/')) return app.voce.gestisci(req, res, { invia });
    return invia(res, 404, { errore: 'Non trovato.' });
  }
  function readBody(req) { return leggiJson(req).catch(() => ({})); }

  return http.createServer((req, res) => {
    req.orbitRicevutaA = performance.now();
    if (!origineOk(req)) return invia(res, 403, { errore: 'Origine non consentita.' });
    gestisci(req, res).catch(err => {
      if (err && err.status) return invia(res, err.status, { errore: err.errore });
      log.error('Errore server: ' + (err && err.stack || err));
      if (!res.headersSent) invia(res, 500, { errore: 'Errore interno di Orbit.' }); else res.end();
    });
  });
}

function avvia() {
  const { settings, problemi } = config.carica();
  log.imposta(settings.log.livello);
  for (const p of problemi) log[p.level === 'error' ? 'error' : 'warn'](p.message);
  config.verificaPercorsi(settings);

  let memoria = null;
  try {
    memoria = require('../memoria/memoria');
    const s = memoria.avvia();
    if (s.ok) log.info('Memoria: ' + s.note + ' note indicizzate (sola lettura) dal vault ' + s.vault);
    else log.warn('Memoria non disponibile: ' + s.errore + ' La chat funziona lo stesso.');
  } catch (e) { log.warn('Memoria non avviata: ' + e.message); memoria = null; }

  const app = creaApp({ settings, problemi, memoria });
  try {
    const ultima = JSON.parse(app.storage.preferenza('verificaModelli', 'null'));
    if (Array.isArray(ultima) && app.provider) { app.provider.verificaModelli = ultima; }
  } catch (e) { /* nessuna verifica salvata */ }
  const server = creaServer(app, { port: settings.port });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      log.info('Orbit sembra gia avviato su http://localhost:' + settings.port);
      apriBrowser(settings.port, settings.browser);
    } else log.error(e);
  });
  server.listen(settings.port, '127.0.0.1', () => {
    log.info('Orbit attivo su http://localhost:' + settings.port + ' (solo questo computer)');
    log.info('File di configurazione facoltativo: ' + settings.envFile + (settings.envFileTrovato ? '' : ' (non trovato, va bene)'));
    log.info('Dati: ' + settings.dataDir);
    log.info('Provider: Claude Code con il login del tuo abbonamento (nessuna chiave API, nessun credito).');
    apriBrowser(settings.port, settings.browser);
  });
  return { app, server };
}

// Apre Orbit in un browser che supporti dettatura e voce italiana. Mai Edge. ORBIT_BROWSER: auto (Chrome se c'e, altrimenti il predefinito),
// default (il browser predefinito di Windows), nessuno, oppure il percorso di un eseguibile.
function trovaChrome() {
  const basi = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const b of basi) { const p = require('path').join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'); if (require('fs').existsSync(p)) return p; }
  return null;
}
function apriBrowser(port, scelta = 'auto') { apriUrl('http://localhost:' + port, scelta); }
function apriUrl(url, scelta = 'auto') {
  if (process.platform !== 'win32' || process.env.ORBIT_OPEN === '0' || scelta === 'nessuno') return;
  if (!/^https?:\/\/[^\s"'<>|^]+$/.test(url)) return;        // solo http(s) senza caratteri che la shell interpreterebbe
  const esplicito = /\.exe$/i.test(scelta) && !/msedge/i.test(scelta) && require('fs').existsSync(scelta) ? scelta : null;
  const eseguibile = esplicito || (scelta === 'auto' || scelta === 'chrome' ? trovaChrome() : null);
  if (eseguibile) {
    try { const c = require('child_process').spawn(eseguibile, [url], { detached: true, stdio: 'ignore' }); c.on('error', () => exec('start "" "' + url + '"')); c.unref(); return; } catch (e) { /* si ricade sul predefinito */ }
  }
  exec('start "" "' + url + '"');   // browser predefinito di Windows
}

if (require.main === module) avvia();
module.exports = { creaServer, avvia, apriUrl };


