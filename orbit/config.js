'use strict';
// Configurazione centralizzata di Orbit: unico punto che legge variabili d'ambiente e file .env.
// Il file .env sta FUORI dal vault (di default %LOCALAPPDATA%\Orbit\.env): le chiavi non finiscono in Obsidian Sync.
const fs = require('fs');
const os = require('os');
const path = require('path');
const memoriaConfig = require('../memoria/config');

const { TIERS } = require('./ai/router/modelli-ammessi');
const { areaBozze: segmentiArea } = require('./ai/autonomia');

function dataDirDefault() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Orbit');
}

// Parser minimale di .env: KEY=VALUE, commenti con #, virgolette opzionali.
function leggiEnvFile(file) {
  const out = {};
  let testo;
  try { testo = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  for (const riga of testo.split(/\r?\n/)) {
    if (riga.trim().startsWith('#')) continue;
    const m = riga.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

function dentro(figlio, padre) {
  const r = path.relative(padre, figlio);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}

// Risolve anche destinazioni ancora da creare, senza creare directory e senza seguire link non risolvibili.
function percorsoReale(p) {
  let corrente = path.resolve(p);
  const mancanti = [];
  for (;;) {
    try { return path.join(fs.realpathSync(corrente), ...mancanti.slice().reverse()); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      let esiste = false;
      try { fs.lstatSync(corrente); esiste = true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (esiste) throw e;
      const parent = path.dirname(corrente);
      if (parent === corrente) throw e;
      mancanti.push(path.basename(corrente)); corrente = parent;
    }
  }
}

function problemiPercorsi({ dataDir, envFile, vaultPath }) {
  const problemi = [];
  try {
    const vault = path.resolve(vaultPath), reale = percorsoReale(vault);
    for (const [p, code, descrizione] of [[dataDir, 'DATA_IN_VAULT', 'La directory dei dati'], [envFile, 'ENV_IN_VAULT', 'Il file .env']]) {
      const assoluto = path.resolve(p);
      if (dentro(assoluto, vault) || dentro(percorsoReale(assoluto), reale)) problemi.push({ level: 'error', code,
        message: descrizione + ' (' + p + ') deve restare fuori dal vault: correggi il percorso prima di avviare Orbit.' });
    }
  } catch (e) {
    problemi.push({ level: 'error', code: 'CONFIG_PATH_UNVERIFIABLE', message: 'Impossibile verificare i percorsi di dati, .env e vault (' + (e.code || 'percorso non valido') + '): Orbit non puo avviarsi in sicurezza.' });
  }
  return problemi;
}

function verificaPercorsi(settings) {
  const problemi = problemiPercorsi(settings);
  if (problemi.length) throw Object.assign(new Error('Avvio interrotto: ' + problemi.map(p => p.message).join(' ')), { code: problemi[0].code });
}

// Modalita di Claude quando ORBIT_CLAUDE_MODALITA non e impostata (docs/PERFORMANCE.md). Rollback senza toccare il codice: ORBIT_CLAUDE_MODALITA=tradizionale.
const MODALITA_CLAUDE_PREDEFINITA = 'persistente';

function num(env, nome, def, { min = 0, max = Infinity, intero = true } = {}, problemi) {
  const raw = env[nome];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (intero && !Number.isInteger(n))) {
    problemi.push({ level: 'error', code: 'BAD_NUMBER', message: nome + ' deve essere un numero' + (intero ? ' intero' : '') + ' tra ' + min + ' e ' + max + ' (trovato "' + raw + '"). Uso ' + def + '.' });
    return def;
  }
  return n;
}

// Carica la configurazione. `envProcesso` e `envFile` sono iniettabili per i test.
function carica({ envProcesso = process.env, envFile } = {}) {
  const problemi = [];
  const fileEnv = envFile || envProcesso.ORBIT_ENV_FILE || path.join(envProcesso.ORBIT_DATA_DIR || dataDirDefault(), '.env');
  const daFile = leggiEnvFile(fileEnv);
  const env = Object.assign({}, daFile || {}, envProcesso);   // il processo ha la precedenza sul file

  const vault = memoriaConfig.vaultPath;
  const dataDir = path.resolve(env.ORBIT_DATA_DIR || dataDirDefault());
  problemi.push(...problemiPercorsi({ dataDir, envFile: fileEnv, vaultPath: vault }));

  // Nessuna chiave API: Orbit usa solo l'abbonamento tramite Claude Code. Una chiave trovata nell'ambiente viene ignorata e rimossa dal processo figlio.
  const chiaviIgnorate = Object.keys(env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(k) && env[k]);
  if (chiaviIgnorate.length) {
    problemi.push({ level: 'warn', code: 'API_ENV_IGNORATE', message: 'Nell\'ambiente ci sono variabili API (' + chiaviIgnorate.join(', ') + '): Orbit le ignora e le toglie al processo di Claude Code, cosi non si paga nulla. Meglio rimuoverle anche da Windows.' });
  }

  const providersAmmessi = ['claude-code'];
  const providersRichiesti = String(env.ORBIT_PROVIDERS || 'claude-code').split(',').map(s => s.trim()).filter(Boolean);
  for (const p of providersRichiesti) {
    if (!providersAmmessi.includes(p)) problemi.push({ level: 'error', code: 'BAD_PROVIDER', message: 'ORBIT_PROVIDERS contiene "' + p + '", non supportato. Disponibili: ' + providersAmmessi.join(', ') + '.' });
  }

  const modelli = {};
  for (const t of TIERS) modelli[t] = (env['ORBIT_MODEL_' + t.toUpperCase()] || '').trim() || null;

  // Smart Inbox (docs/smart-inbox-ts6a.md): disattivato salvo ORBIT_SMART_INBOX_AMBITO = file JSON dell'host con lo scope. Mai derivato dal vault.
  let smartInbox = null;
  if (env.ORBIT_SMART_INBOX_AMBITO) {
    try { smartInbox = JSON.parse(fs.readFileSync(path.resolve(env.ORBIT_SMART_INBOX_AMBITO), 'utf8')); } catch (e) {
      problemi.push({ level: 'error', code: 'SMART_INBOX_AMBITO', message: 'ORBIT_SMART_INBOX_AMBITO non e un file JSON leggibile: Smart Inbox resta disattivato.' });
    }
  }

  // Area bozze (docs/AUTONOMIA.md): cartella del vault dove Orbit crea note NUOVE senza chiedere conferma. Spenta se vuota o non valida; mai derivata dal vault.
  let areaBozze = '';
  if ((env.ORBIT_AREA_BOZZE || '').trim()) {
    try { segmentiArea(env.ORBIT_AREA_BOZZE); areaBozze = env.ORBIT_AREA_BOZZE.trim(); } catch (e) {
      problemi.push({ level: 'error', code: 'AREA_BOZZE', message: 'ORBIT_AREA_BOZZE non e una cartella valida del vault (' + (e.codice || 'non valida') + '): area bozze spenta.' });
    }
  }

  const settings = {
    smartInbox, areaBozze, envFile: fileEnv, envFileTrovato: !!daFile, dataDir,
    port: num(env, 'ORBIT_PORT', 4778, { min: 1, max: 65535 }, problemi),
    browser: (env.ORBIT_BROWSER || 'auto').trim(), providers: String(env.ORBIT_PROVIDERS || 'claude-code').split(',').map(s => s.trim()).filter(Boolean), claudeBin: env.ORBIT_CLAUDE || 'claude', ccCwd: path.join(dataDir, 'cc-cwd'), chiaviIgnorate,
    // Claude persistente (docs/PERFORMANCE.md): ORBIT_CLAUDE_MODALITA=tradizionale (predefinita) | persistente
    claudePersistente: {
      modalita: String(env.ORBIT_CLAUDE_MODALITA || MODALITA_CLAUDE_PREDEFINITA).trim().toLowerCase() === 'persistente' ? 'persistente' : 'tradizionale',
      riuso: num(env, 'ORBIT_CLAUDE_RIUSO', 1, { min: 1, max: 100 }, problemi), pool: num(env, 'ORBIT_CLAUDE_POOL', 2, { min: 1, max: 4 }, problemi),
      ttlMs: num(env, 'ORBIT_CLAUDE_TTL_MS', 600000, { min: 10000 }, problemi),
      avvioAutomatico: env.ORBIT_CLAUDE_AVVIO_AUTOMATICO !== '0',
      web: env.ORBIT_CLAUDE_WEB_PERSISTENTE === '1',        // sperimentale: ricerca web su processi persistenti (non validata)
      prewarm: String(env.ORBIT_CLAUDE_PREWARM === undefined ? 'haiku,sonnet' : env.ORBIT_CLAUDE_PREWARM).split(',').map(x => x.trim()).filter(Boolean)
    },
    modelli, autodetect: env.ORBIT_MODEL_AUTODETECT !== '0',
    limiti: {
      maxInputTokens: num(env, 'ORBIT_MAX_INPUT_TOKENS', 12000, { min: 500 }, problemi),
      maxOutputTokens: num(env, 'ORBIT_MAX_OUTPUT_TOKENS', 2048, { min: 64 }, problemi),
      budgetTokenRichiesta: num(env, 'ORBIT_BUDGET_TOKENS_REQUEST', 60000, { min: 1000 }, problemi),
      budgetTokenTentativo: num(env, 'ORBIT_BUDGET_TOKENS_ATTEMPT', 24000, { min: 500 }, problemi),
      maxEscalation: num(env, 'ORBIT_MAX_ESCALATIONS', 2, { min: 0, max: 5 }, problemi),
      maxTentativi: num(env, 'ORBIT_MAX_ATTEMPTS', 4, { min: 1, max: 10 }, problemi),
      timeoutChiamataMs: num(env, 'ORBIT_TIMEOUT_MS', 90000, { min: 1000 }, problemi),
      timeoutRichiestaMs: num(env, 'ORBIT_REQUEST_TIMEOUT_MS', 240000, { min: 1000 }, problemi),
      limiteGiornalieroToken: num(env, 'ORBIT_DAILY_TOKEN_LIMIT', 0, { min: 0 }, problemi),            // 0 = nessun limite
      chiamatePerOra: num(env, 'ORBIT_MAX_CALLS_PER_HOUR', 30, { min: 1 }, problemi),
      chiamatePerGiorno: num(env, 'ORBIT_MAX_CALLS_PER_DAY', 150, { min: 1 }, problemi),
      verificaAI: ['auto', 'sempre'].includes(env.ORBIT_AI_VERIFY) ? env.ORBIT_AI_VERIFY : 'auto',
      richiestePerMinuto: num(env, 'ORBIT_RATE_LIMIT_PER_MIN', 20, { min: 1 }, problemi),
      maxRetryApi: num(env, 'ORBIT_API_RETRIES', 1, { min: 0, max: 5 }, problemi)
    },
    performanceTrace: env.ORBIT_TRACE !== '0',
    log: { livello: ['error', 'warn', 'info', 'debug'].includes(env.ORBIT_LOG_LEVEL) ? env.ORBIT_LOG_LEVEL : 'info' },
    // Riconoscimento vocale (vedi docs/WHISPER-STT.md). Unico punto di configurazione: per passare da Small a Base basta
    // ORBIT_STT_MODELLO=base e il file del modello (node orbit/tools/installa-stt.js --modello base). Nessun ripiego automatico.
    stt: {
      motore: ['whisper', 'browser'].includes(env.ORBIT_STT_MOTORE) ? env.ORBIT_STT_MOTORE : 'whisper',
      modello: ['small', 'base'].includes(env.ORBIT_STT_MODELLO) ? env.ORBIT_STT_MODELLO : 'small',
      lingua: /^[a-z]{2}$|^auto$/.test(env.ORBIT_STT_LINGUA || '') ? env.ORBIT_STT_LINGUA : 'it',
      thread: num(env, 'ORBIT_STT_THREADS', 6, { min: 1, max: 32 }, problemi),
      contesto: num(env, 'ORBIT_STT_CONTESTO', 3, { min: 0, max: 10 }, problemi),         // 0 = finestra piena di 30 s (piu lento, appena piu preciso)
      dir: path.resolve(env.ORBIT_STT_DIR || path.join(dataDir, 'stt')),
      paroleAttivazione: String(env.ORBIT_STT_PAROLA || 'orbit').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
      varianti: String(env.ORBIT_STT_VARIANTI || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),       // grafie date da Vosk a «Orbit», valide solo a inizio frase
      diagnostica: env.ORBIT_STT_DIAGNOSTICA === '1',                                                                 // scrive nella console il testo grezzo di ogni trascrizione (dati personali, solo per le prove)
      diagnosticaDir: env.ORBIT_STT_DIAGNOSTICA === '1' && env.ORBIT_STT_DIAGNOSTICA_DIR ? path.resolve(env.ORBIT_STT_DIAGNOSTICA_DIR) : '',   // con la diagnostica salva gli ultimi 10 WAV ricevuti (registrazioni della voce: solo per le prove)
      prompt: String(env.ORBIT_STT_PROMPT || '').replace(/\s+/g, ' ').trim().slice(0, 200)                           // vocabolario di partenza per Whisper (default spento: su un comando reale a piu frasi Whisper si e fermato alla prima)
    },
    // Sintesi vocale (vedi docs/ELEVENLABS.md). La chiave ELEVENLABS_API_KEY non sta qui: si legge solo al momento dell'uso, mai nei settings.
    tts: {
      motore: env.ORBIT_TTS_MOTORE === 'piper' ? 'piper' : 'elevenlabs',          // elevenlabs con ripiego automatico su Piper; piper = solo locale
      modello: (env.ORBIT_TTS_MODELLO || '').trim() || 'eleven_v3',
      voceId: (env.ORBIT_TTS_VOCE_ID || '').trim(),
      tettoMese: num(env, 'ORBIT_TTS_MAX_CARATTERI_MESE', 0, { min: 0 }, problemi)   // 0 = il limite del piano
    },
    vaultPath: vault
  };

  if (settings.limiti.budgetTokenTentativo > settings.limiti.budgetTokenRichiesta) {
    problemi.push({ level: 'warn', code: 'ATTEMPT_BUDGET', message: 'Il budget per tentativo supera quello per richiesta: conta il piu basso.' });
  }
  return { settings, problemi };
}

// Versione dei settings sicura da mostrare nell'interfaccia: mai la chiave.
function pubblica(settings) {
  return Object.assign({}, settings);
}

module.exports = { carica, pubblica, leggiEnvFile, verificaPercorsi, TIERS, dataDirDefault, MODALITA_CLAUDE_PREDEFINITA };
