'use strict';
// Riconoscimento vocale locale: Whisper (processo unico, finestra audio, filtri), parola "Orbit" (Vosk), rotte /api/voce e logica del
// browser (microfono simulato). Nessun modello vero: falsi whisper-server e Vosk, e un microfono finto che produce frame noti.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WhisperSTT, pulisci, durataWav } = require('../voice/whisper');
const { ParolaVosk } = require('../voice/parola');
const { creaVoceLocale } = require('../voice/voce-locale');
const voce = require('../public/voice.js');
const { creaApp } = require('../app');
const { creaServer } = require('../server');
const { Storage } = require('../storage/db');
const { MockProvider, settingsProva } = require('./helpers');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stt-'));
fs.mkdirSync(path.join(BASE, 'modelli')); fs.writeFileSync(path.join(BASE, 'modelli', 'ggml-small-q8_0.bin'), 'finto');
const FAKE_W = path.join(__dirname, 'fake-whisper.js'), FAKE_V = path.join(__dirname, 'fake-vosk.js');
const whisperFinto = (extra = {}) => new WhisperSTT(Object.assign({ dir: BASE, exe: process.execPath, binArgs: [FAKE_W] }, extra));
const parolaFinta = () => new ParolaVosk({ dir: BASE, python: process.execPath, script: FAKE_V, modello: BASE, parole: ['orbit'] });
function wavDi(secondi, valore = 3000) { const n = Math.round(secondi * 16000); const pcm = new Int16Array(n).fill(valore); return Buffer.from(voce.wav(pcm)); }

// ---------- Whisper ----------
test('whisper: testo ripulito dalle allucinazioni tipiche, comandi veri mai scartati', () => {
  assert.equal(pulisci(' [Musica]\n'), ''); assert.equal(pulisci('(applausi)'), ''); assert.equal(pulisci('Sottotitoli a cura di QTSS'), '');
  assert.equal(pulisci('Grazie per la visione!'), ''); assert.equal(pulisci(' Orbit, ciao. '), 'Orbit, ciao.'); assert.equal(pulisci('Grazie a tutti i prof'), 'Grazie a tutti i prof');
  assert.equal(durataWav(wavDi(2)), 2); assert.equal(durataWav(Buffer.from('non un wav')), null);
});

test('whisper: un solo processo anche con avvii e trascrizioni contemporanee; finestra audio proporzionale; audio vuoto o non valido', async () => {
  const w = whisperFinto({ contesto: 3 });
  try {
    assert.equal(w.stato().pronto, false);
    const [a, b] = await Promise.all([w.avvia(), w.avvia()]);
    assert.equal(a && b, true); const pid = w.stato().pid; assert.ok(pid);
    const r = await Promise.all([w.trascrivi(wavDi(2)), w.trascrivi(wavDi(4))]);
    assert.equal(w.stato().pid, pid);                                              // nessun secondo processo
    assert.equal(r[0].testo, 'Orbit, cosa devo fare oggi?'); assert.equal(r[0].vuoto, false);
    assert.equal(r[0].durataAudioS, 2); assert.ok(r[0].latenzaMs >= 0); assert.ok(typeof r[0].rtf === 'number');
    assert.equal(w.ultima.contesto, 640);                                          // 4 s * 50 * 3 = 600 -> multiplo di 64
    assert.deepEqual(await w.trascrivi(wavDi(0.2)), { testo: '', vuoto: true, motivo: 'registrazione troppo breve', durataAudioS: 0.2 });
    await assert.rejects(w.trascrivi(Buffer.from('xx')), e => e.codice === 'AUDIO_NON_VALIDO');
    await assert.rejects(w.trascrivi(wavDi(61)), e => e.codice === 'TROPPO_LUNGA');
  } finally { w.ferma(); }
});

test('whisper: trascrizione poco affidabile non viene inviata; modello assente = errore chiaro; dopo un arresto riparte', async () => {
  process.env.FAKE_WHISPER_LOGPROB = '-2.5';
  const w = whisperFinto();
  try {
    const r = await w.trascrivi(wavDi(2));
    assert.equal(r.vuoto, true); assert.equal(r.testo, ''); assert.equal(r.motivo, 'trascrizione poco affidabile');
    w.proc.kill(); await new Promise(r2 => setTimeout(r2, 300));
    assert.equal(w.stato().pronto, false); assert.match(w.stato().errore, /si e fermato/);
    delete process.env.FAKE_WHISPER_LOGPROB;
    assert.equal((await w.trascrivi(wavDi(1))).testo, 'Orbit, cosa devo fare oggi?');      // riavvio alla richiesta successiva
  } finally { delete process.env.FAKE_WHISPER_LOGPROB; w.ferma(); }
  const assente = new WhisperSTT({ dir: path.join(BASE, 'non-esiste') });
  assert.equal(await assente.avvia(), false); assert.match(assente.stato().errore, /installa-stt\.js/);
  await assert.rejects(assente.trascrivi(wavDi(1)), e => e.codice === 'NON_PRONTO');
});

// ---------- parola di attivazione ----------
test('parola "Orbit": processo separato, pacchetti in ordine, tempo della fine della parola, azzeramento', async () => {
  const p = parolaFinta();
  try {
    const silenzio = Buffer.alloc(8000);
    assert.deepEqual(await p.analizza(silenzio), { attivata: false, fine: null, campioni: 4000 });
    const conParola = Buffer.alloc(8000); conParola.writeInt16LE(12345, 0);
    const r = await p.analizza(conParola);
    assert.equal(r.attivata, true); assert.equal(r.fine, 0.65); assert.equal(r.campioni, 8000);                        // 4000 campioni prima (0,25 s) + 0,4 s
    await p.azzera();
    assert.equal((await p.analizza(conParola)).fine, 0.4);
    assert.equal(p.stato().attivazioni, 2);
  } finally { p.ferma(); }
});

// ---------- rotte del backend ----------
async function conServer(fn) {
  const settings = settingsProva({ settings: { dataDir: path.join(BASE, 'dati') } });
  const vl = creaVoceLocale({ settings, whisper: whisperFinto(), parola: parolaFinta() });
  const app = creaApp({ settings, provider: new MockProvider(), storage: new Storage(':memory:'), voce: vl });
  const s0 = creaServer(app, { port: 0 }); await new Promise(r => s0.listen(0, '127.0.0.1', r)); const port = s0.address().port; s0.close();
  const s = creaServer(app, { port }); await new Promise(r => s.listen(port, '127.0.0.1', r));
  try { await fn('http://localhost:' + port, vl); } finally { vl.ferma(); s.closeAllConnections(); await new Promise(r => s.close(r)); }
}

test('rotte /api/voce: stato, parola, trascrizione; intestazione obbligatoria e limiti di dimensione', async () => {
  await conServer(async (base, vl) => {
    const st = await (await fetch(base + '/api/voce/stato')).json();
    assert.equal(st.motore, 'whisper'); assert.equal(st.stt.motore, 'whisper.cpp'); assert.match(st.stt.modello, /Whisper Small multilingue/);
    // la prima richiesta di stato (all'apertura dell'interfaccia) prepara Whisper e Vosk in background, senza bloccare la risposta
    assert.equal(st.stt.pronto, false); await vl.whisper.avvio; await vl.parola.avvio;
    const pronto = await (await fetch(base + '/api/voce/stato')).json(); assert.equal(pronto.stt.pronto, true); assert.equal(pronto.parola.pronto, true);
    const H = { 'X-Orbit': '1', 'Content-Type': 'application/octet-stream' };
    const pcm = Buffer.alloc(8000); pcm.writeInt16LE(12345, 0);
    assert.deepEqual(await (await fetch(base + '/api/voce/ascolta', { method: 'POST', headers: H, body: pcm })).json(), { attivata: true, fine: 0.4, campioni: 4000 });
    assert.equal((await fetch(base + '/api/voce/ascolta', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm })).status, 403);
    assert.equal((await fetch(base + '/api/voce/ascolta', { method: 'POST', headers: H, body: Buffer.alloc(200 * 1024) })).status, 413);
    const t = await (await fetch(base + '/api/voce/trascrivi', { method: 'POST', headers: { 'X-Orbit': '1', 'Content-Type': 'audio/wav' }, body: wavDi(2) })).json();
    assert.equal(t.testo, 'Orbit, cosa devo fare oggi?'); assert.equal(t.durataAudioS, 2);
    assert.equal((await fetch(base + '/api/voce/trascrivi', { method: 'POST', headers: { 'X-Orbit': '1', 'Content-Type': 'audio/wav' }, body: Buffer.from('xx') })).status, 400);
    assert.equal((await fetch(base + '/api/voce/trascrivi', { method: 'POST', headers: { 'X-Orbit': '1', 'Content-Type': 'audio/wav' }, body: Buffer.alloc(3 * 1024 * 1024) })).status, 413);
    assert.equal(vl.whisper.stato().trascrizioni, 1);
  });
});

test('diagnostica STT: spenta di default non scrive il testo, accesa mostra il testo grezzo', async () => {
  for (const diagnostica of [false, true]) {
    const righe = [], log = { info: m => righe.push(m), warn() {} };
    const settings = { stt: { motore: 'whisper', diagnostica } };
    const vl = creaVoceLocale({ settings, log, whisper: { trascrivi: async () => ({ testo: 'perche non lo fai', vuoto: false, durataAudioS: 2 }), avvia() {}, stato: () => ({}), disponibile: () => true, ferma() {} }, parola: { avvia() {}, stato: () => ({}), disponibile: () => true, ferma() {} } });
    const req = Object.assign(require('stream').Readable.from([wavDi(2)]), { url: '/api/voce/trascrivi', method: 'POST', headers: { 'x-orbit': '1', 'content-type': 'audio/wav' } });
    await vl.gestisci(req, {}, { invia: () => {} });
    assert.equal(righe.some(r => r.includes('perche non lo fai')), diagnostica);
  }
});

// ---------- browser: microfono simulato ----------
function browserFinto() {
  const nodi = [];
  const tracce = [];
  class AC {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = {}; this.chiuso = false; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { const n = { onaudioprocess: null, connect() {}, disconnect() {} }; nodi.push(n); return n; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.chiuso = true; }
  }
  const win = {
    permesso: true, ascoltatori: {},
    navigator: { mediaDevices: { getUserMedia: (vincoli) => { win.vincoli = vincoli; if (!win.permesso) return Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })); const t = { attiva: true, stop() { t.attiva = false; }, onended: null }; tracce.push(t); return Promise.resolve({ getTracks: () => [t] }); } } },
    AudioContext: AC,
    addEventListener(e, f) { (win.ascoltatori[e] = win.ascoltatori[e] || []).push(f); }
  };
  // audio: array di [secondi, ampiezza, marcatore?]; ogni blocco e passato al nodo attivo in pezzi da 4096 campioni
  const suona = blocchi => {
    const n = nodi[nodi.length - 1]; if (!n || !n.onaudioprocess) return;
    for (const [sec, amp, marca] of blocchi) {
      const tot = Math.round(sec * 16000); const s = new Float32Array(tot);
      for (let i = 0; i < tot; i++) s[i] = amp ? amp * Math.sin(i / 3) : 0;
      if (marca) s[0] = 12345 / 32767;
      for (let i = 0; i < tot; i += 4096) { const pezzo = s.slice(i, i + 4096); if (!n.onaudioprocess) return; n.onaudioprocess({ inputBuffer: { getChannelData: () => pezzo } }); }
    }
  };
  return { win, suona, tracce };
}
function backendFinto({ testo = ' Orbit, cosa devo fare oggi?', disponibile = true } = {}) {
  const b = { pacchetti: 0, campioniInviati: 0, trascritti: [], azzeramenti: 0, riavviaAlProssimo: false, scartaPacchetto: 0 };
  b.chiama = async (url, o = {}) => {
    const risposta = (j, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => j });
    if (url === '/api/voce/stato') return risposta({ motore: 'whisper', stt: { disponibile }, parola: { disponibile } });
    if (url === '/api/voce/azzera') { b.campioniInviati = 0; b.azzeramenti++; return risposta({ ok: true }); }
    if (url === '/api/voce/ascolta') {
      const pcm = new Int16Array(o.body); b.pacchetti++;
      if (b.scartaPacchetto && b.pacchetti === b.scartaPacchetto) return risposta({ errore: 'pacchetto perso' }, false);
      if (b.riavviaAlProssimo) { b.riavviaAlProssimo = false; b.campioniInviati = 0; }          // Vosk spento dopo 10 minuti e ripartito da zero
      const i = pcm.indexOf(12345); const inizio = b.campioniInviati; b.campioniInviati += pcm.length;
      return risposta(i >= 0 ? { attivata: true, fine: (inizio + i) / 16000 + 0.4, campioni: b.campioniInviati } : { attivata: false, campioni: b.campioniInviati });
    }
    if (url === '/api/voce/trascrivi') { const d = (o.body.byteLength - 44) / 32000; b.trascritti.push(d); return risposta(d < 0.35 ? { testo: '', vuoto: true } : { testo, vuoto: false }); }
    return risposta({}, false);
  };
  return b;
}
const pausa = ms => new Promise(r => setTimeout(r, ms));

test('browser: "Orbit, cosa devo fare oggi?" senza pausa -> comando completo, senza la parola, poi pausa fino a quando Orbit ha finito', async () => {
  const { win, suona, tracce } = browserFinto(); const be = backendFinto();
  const ev = [];
  const p = voce.creaParolaLocale(win, { onStato: s => ev.push('stato:' + s), onAttivata: () => ev.push('attivata'), onComando: t => ev.push('comando:' + t), onTesto: t => ev.push('testo:' + t), onErrore: m => ev.push('errore:' + m) }, { chiama: be.chiama, riavvioMs: 5 });
  p.avvia({ motore: 'whisper', stt: { disponibile: true }, parola: { disponibile: true } }); await pausa(20);
  assert.ok(ev.includes('stato:attesa'));
  suona([[1, 0]]); await pausa(20);
  assert.equal(be.pacchetti, 0);                                                   // in silenzio non si manda nulla e non si usa Whisper
  suona([[0.6, 0.3, true], [1.4, 0.3]]); await pausa(30);                          // "Orbit" + comando, senza pausa
  assert.ok(ev.includes('attivata')); assert.ok(ev.includes('stato:attivata'));
  suona([[1.2, 0]]); await pausa(30);                                              // pausa finale -> trascrizione
  assert.equal(be.trascritti.length, 1);
  assert.ok(be.trascritti[0] > 1.4 && be.trascritti[0] < 3, 'audio del comando: ' + be.trascritti[0]);   // dalla fine della parola, non dall'inizio
  assert.ok(ev.includes('comando:cosa devo fare oggi?'), ev.join(' | '));
  assert.ok(ev.includes('stato:pausa'));
  assert.equal(tracce.filter(t => t.attiva).length, 0);                           // microfono rilasciato mentre Orbit lavora e parla
  assert.deepEqual(win.vincoli.audio, { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false });   // il guadagno automatico saturava
  p.riprendi(); await pausa(30);
  assert.equal(ev.filter(e => e === 'stato:attesa').length, 2);                   // torna in attesa della parola
  p.ferma(); assert.equal(tracce.filter(t => t.attiva).length, 0);
});

test('browser: dopo "Orbit" il livello del microfono anima il nucleo, solo durante il comando, e torna a zero', async () => {
  const { win, suona } = browserFinto(); const be = backendFinto();
  const livelli = []; let attivata = false;
  const p = voce.creaParolaLocale(win, { onAttivata: () => { attivata = true; }, onLivello: v => livelli.push({ v, attivata }) }, { chiama: be.chiama, riavvioMs: 5 });
  p.avvia(null); await pausa(20);
  suona([[0.6, 0.3, true]]); await pausa(30);                                      // "Orbit": in attesa nessun livello
  assert.ok(attivata); assert.deepEqual(livelli, []);
  suona([[0.8, 0.3]]); await pausa(10);                                            // il comando, dopo l'attivazione
  assert.ok(livelli.some(l => l.v > 0.3), 'il parlato del comando muove il nucleo');
  suona([[1.2, 0]]); await pausa(30);
  assert.equal(livelli[livelli.length - 1].v, 0);                                  // a fine comando il nucleo si ferma
  p.ferma();
});

test('browser: solo "Orbit" e poi silenzio -> torna in attesa; rumore di fondo -> nessuna attivazione; trascrizione vuota -> niente comando', async () => {
  const { win, suona } = browserFinto(); const be = backendFinto({ testo: '' });
  const ev = [];
  const p = voce.creaParolaLocale(win, { onStato: s => ev.push('stato:' + s), onAttivata: () => ev.push('attivata'), onComando: t => ev.push('comando:' + t), onTesto: t => ev.push('testo:' + t) }, { chiama: be.chiama, riavvioMs: 5, attesaComandoMs: 60 });
  p.avvia(null); await pausa(20);
  suona([[2, 0.002]]); await pausa(20);                                            // fruscio sotto la soglia
  assert.equal(ev.includes('attivata'), false); assert.equal(be.pacchetti, 0);
  suona([[0.4, 0.3, true], [0.3, 0]]); await pausa(120);                           // solo "Orbit"
  assert.ok(ev.includes('attivata')); assert.ok(ev.includes('testo:')); assert.equal(ev[ev.length - 1], 'stato:attesa');
  assert.equal(be.trascritti.length, 0);                                           // niente parlato dopo la parola: nessuna trascrizione
  suona([[0.4, 0.3, true], [0.8, 0.3]]); await pausa(30); suona([[1.1, 0]]); await pausa(60);   // comando, ma Whisper non riconosce nulla
  assert.equal(be.trascritti.length, 1); assert.equal(ev.some(e => e.startsWith('comando:')), false);
  assert.equal(ev[ev.length - 1], 'stato:attesa');                                 // e si torna ad ascoltare da soli
  p.ferma();
});

test('browser: permesso negato o motore non installato; dettatura con pausa finale; pagina chiusa = microfono rilasciato', async () => {
  const a = browserFinto(); a.win.permesso = false; const be = backendFinto();
  const ev = [];
  const p = voce.creaParolaLocale(a.win, { onStato: (s, d) => ev.push(s + (d ? ':' + d : '')), onErrore: m => ev.push('errore:' + m) }, { chiama: be.chiama });
  p.avvia(null); await pausa(20);
  assert.ok(ev.includes('errore:not-allowed')); assert.equal(p.attiva(), false);
  const ev2 = [];
  const q = voce.creaParolaLocale(browserFinto().win, { onStato: s => ev2.push(s), onErrore: m => ev2.push(m) }, { chiama: be.chiama });
  q.avvia({ motore: 'whisper', stt: { disponibile: false }, parola: { disponibile: true } });
  assert.match(ev2.join(' '), /installa-stt\.js/); assert.ok(ev2.includes('spento')); assert.equal(q.attiva(), false);
  // dettatura (pulsante del microfono)
  const b = browserFinto(); const be2 = backendFinto({ testo: ' Quando e il parziale di analisi?' });
  const r = voce.creaRiconoscimentoLocale(b.win, { chiama: be2.chiama, finePausaMs: 400 });
  let finale = null, inizio = false;
  r.avvia({ onInizio: () => { inizio = true; }, onFine: t => { finale = t; }, onErrore: () => {}, onLivello: () => {}, onInterim: () => {} }); await pausa(20);
  assert.equal(inizio, true); assert.equal(r.attivo(), true);
  b.suona([[1, 0.3], [0.5, 0]]); await pausa(40);
  assert.equal(finale, 'Quando e il parziale di analisi?'); assert.equal(r.attivo(), false);
  assert.equal(b.tracce.filter(t => t.attiva).length, 0);
  // pagina chiusa durante l'attesa della parola
  const c = browserFinto(); const s = voce.creaParolaLocale(c.win, {}, { chiama: backendFinto().chiama });
  s.avvia(null); await pausa(20); assert.equal(c.tracce.filter(t => t.attiva).length, 1);
  for (const f of c.win.ascoltatori.pagehide) f();
  assert.equal(c.tracce.filter(t => t.attiva).length, 0);
});

test('browser: interfaccia pubblica invariata per app.js (stessi metodi e callback) e motore scelto dal backend', async () => {
  const { win } = browserFinto(); const be = backendFinto();
  const r = voce.creaRiconoscimento(win, { fetchFn: be.chiama }); const a = voce.creaParolaDiAttivazione(win, {}, { fetchFn: be.chiama });
  for (const k of ['supportato', 'attivo', 'avvia', 'ferma']) assert.ok(k in r, k);
  for (const k of ['supportata', 'attiva', 'avvia', 'ferma', 'pausa', 'riprendi']) assert.ok(k in a, k);
  assert.equal(r.supportato, true); assert.equal(a.supportata, true);
  assert.equal(voce.pulisciComando('Orbit, cosa devo fare oggi?'), 'cosa devo fare oggi?'); assert.equal(voce.pulisciComando('le orbite dei pianeti'), 'le orbite dei pianeti');
});

// ---------- correzioni di affidabilita (18 ottobre) ----------
test('whisper: il vocabolario di partenza arriva solo se configurato; eco del prompt e rumore non diventano testo', async () => {
  process.env.FAKE_WHISPER_ECO_PROMPT = '1';
  const senza = whisperFinto(), con = whisperFinto({ prompt: 'Orbit, esami del Politecnico' });
  try {
    assert.equal((await senza.trascrivi(wavDi(2))).testo, 'senza prompt');
    assert.equal((await con.trascrivi(wavDi(2))).testo, 'prompt:Orbit, esami del Politecnico');
  } finally { delete process.env.FAKE_WHISPER_ECO_PROMPT; senza.ferma(); con.ferma(); }
  process.env.FAKE_WHISPER_TESTO = ' esami del Politecnico';
  const eco = whisperFinto({ prompt: 'Orbit, esami del Politecnico' }), altro = whisperFinto();
  try {
    const r = await eco.trascrivi(wavDi(2)); assert.equal(r.vuoto, true); assert.equal(r.testo, '');         // ripete il prompt: non e parlato
    assert.equal((await altro.trascrivi(wavDi(2))).testo, 'esami del Politecnico');                          // senza prompt configurato resta testo normale
  } finally { delete process.env.FAKE_WHISPER_TESTO; eco.ferma(); altro.ferma(); }
  process.env.FAKE_WHISPER_NESSUN_PARLATO = '0.9'; process.env.FAKE_WHISPER_LOGPROB = '-1.5';
  const rumore = whisperFinto();
  try { const r = await rumore.trascrivi(wavDi(2)); assert.equal(r.vuoto, true); assert.equal(r.motivo, 'nessun parlato riconosciuto'); } finally { delete process.env.FAKE_WHISPER_LOGPROB; rumore.ferma(); }
  const sicuro = whisperFinto();                                                                              // alta probabilita di "nessun parlato" ma fiducia alta: testo vero
  try { assert.equal((await sicuro.trascrivi(wavDi(2))).testo, 'Orbit, cosa devo fare oggi?'); } finally { delete process.env.FAKE_WHISPER_NESSUN_PARLATO; sicuro.ferma(); }
});

test('parola: se Vosk non risponde in tempo il processo riparte e una risposta tardiva non si attribuisce alla richiesta dopo', async () => {
  process.env.FAKE_VOSK_RITARDO_MS = '600';
  const p = new ParolaVosk({ dir: BASE, python: process.execPath, script: FAKE_V, modello: BASE, parole: ['orbit'], rispostaMaxMs: 150 });
  try {
    const lento = Buffer.alloc(8000); lento.writeInt16LE(1111, 0);
    await assert.rejects(p.analizza(lento), /non risponde/);
    assert.equal(p.stato().pronto, false);
    delete process.env.FAKE_VOSK_RITARDO_MS;
    assert.deepEqual(await p.analizza(Buffer.alloc(8000)), { attivata: false, fine: null, campioni: 4000 });   // processo nuovo: il conto riparte da zero
  } finally { delete process.env.FAKE_VOSK_RITARDO_MS; p.ferma(); }
});

test('VAD: un rumore alto e costante non resta "parlato"; il parlato vero si riconosce e finisce con il silenzio', () => {
  const frame = (ampiezza, f = 0.37) => { const x = new Int16Array(320); for (let i = 0; i < 320; i++) x[i] = Math.round(ampiezza * Math.sin(i * f)); return x; };
  const vad = voce.creaVad();
  const ultimi = [];
  for (let n = 0; n < 500; n++) { const v = vad(frame(464, 0.37 + (n % 7) * 0.05)); if (n >= 300) ultimi.push(v.parlato); }     // rumore a circa -40 dBFS per 10 s
  assert.equal(ultimi.some(Boolean), false, 'dopo 6 s il rumore costante non deve risultare parlato');
  const parlato = []; for (let n = 0; n < 40; n++) parlato.push(vad(frame(n % 6 < 4 ? 9000 : 1500, 0.2 + n * 0.01)).parlato);
  assert.ok(parlato.filter(Boolean).length >= 25, 'il parlato (livello e sillabe variabili) si riconosce');
  const dopo = []; for (let n = 0; n < 30; n++) dopo.push(vad(frame(464)).parlato);
  assert.equal(dopo.slice(10).some(Boolean), false, 'tornato il solo rumore, il parlato finisce');
  const quieto = voce.creaVad(); let scatti = 0; for (let n = 0; n < 200; n++) if (quieto(frame(65)).parlato) scatti++;   // fruscio a circa -57 dBFS
  assert.equal(scatti, 0);
  const digitale = voce.creaVad(); for (let n = 0; n < 100; n++) digitale(new Int16Array(320));                     // silenzio digitale prima del rumore
  let rumorosi = 0; for (let n = 0; n < 400; n++) if (digitale(frame(464)).parlato) rumorosi++;
  assert.ok(rumorosi <= 210, 'anche dopo il silenzio digitale il rumore si ricalibra entro circa 4 s, frame parlato: ' + rumorosi);
});

test('browser: «Orbit», pausa lunga, poi il comando -> il comando non viene troncato alla coda di «Orbit»', async () => {
  const { win, suona } = browserFinto(); const be = backendFinto();
  const ev = [];
  const p = voce.creaParolaLocale(win, { onStato: s => ev.push('stato:' + s), onComando: t => ev.push('comando:' + t), onErrore: m => ev.push('errore:' + m) }, { chiama: be.chiama, riavvioMs: 5 });
  p.avvia(null); await pausa(20);
  suona([[0.6, 0.3, true]]); await pausa(30);                                      // solo «Orbit» (la fine stimata e 0,4 s dopo l'inizio)
  suona([[1.6, 0]]); await pausa(10);                                              // pausa piu lunga della pausa di fine comando
  assert.equal(be.trascritti.length, 0, 'la pausa dopo «Orbit» non chiude il comando');
  suona([[1, 0.3]]); await pausa(10); suona([[1.2, 0]]); await pausa(40);
  assert.equal(be.trascritti.length, 1);
  assert.ok(be.trascritti[0] > 1.0 && be.trascritti[0] < 1.9, 'audio del comando senza pausa e senza silenzio finale: ' + be.trascritti[0]);
  assert.ok(ev.includes('comando:cosa devo fare oggi?'), ev.join(' | '));
  p.ferma();
});

for (const [nome, preparaBackend] of [['Vosk ripartito da zero dopo 10 minuti', be => { be.riavviaAlProssimo = true; }], ['un pacchetto perso', be => { be.scartaPacchetto = 1; }]]) {
  test('browser: ' + nome + ' -> il comando parte dal punto giusto, senza audio vecchio', async () => {
    const { win, suona } = browserFinto(); const be = backendFinto();
    const ev = [];
    const p = voce.creaParolaLocale(win, { onComando: t => ev.push('comando:' + t), onErrore: m => ev.push('errore:' + m) }, { chiama: be.chiama, riavvioMs: 5 });
    p.avvia(null); await pausa(20);
    if (nome === 'un pacchetto perso') preparaBackend(be);
    suona([[0.8, 0.3]]); await pausa(30);                                          // parlato qualsiasi, senza «Orbit»
    suona([[1.2, 0]]); await pausa(30);
    if (nome !== 'un pacchetto perso') preparaBackend(be);
    suona([[0.6, 0.3, true], [1, 0.3]]); await pausa(30);
    suona([[1.2, 0]]); await pausa(40);
    assert.equal(be.trascritti.length, 1, ev.join(' | '));
    assert.ok(be.trascritti[0] > 1.0 && be.trascritti[0] < 2.6, 'solo il comando, non il parlato di prima: ' + be.trascritti[0]);
    p.ferma();
  });
}

test('browser: comando vuoto o non riconosciuto dopo «Orbit» avvisa chi ha parlato; dettatura senza il silenzio prima e dopo', async () => {
  const { win, suona } = browserFinto(); const be = backendFinto({ testo: '' });
  const ev = [];
  const p = voce.creaParolaLocale(win, { onComando: t => ev.push('comando:' + t), onErrore: m => ev.push('errore:' + m), onStato: s => ev.push('stato:' + s) }, { chiama: be.chiama, riavvioMs: 5 });
  p.avvia(null); await pausa(20);
  suona([[0.6, 0.3, true], [1, 0.3]]); await pausa(30); suona([[1.2, 0]]); await pausa(40);
  assert.ok(ev.includes('errore:Non ho sentito niente, riprova.'), ev.join(' | '));
  assert.equal(ev.some(e => e.startsWith('comando:')), false);
  p.ferma();
  const b = browserFinto(); const be2 = backendFinto({ testo: ' Quando e il parziale?' });
  const r = voce.creaRiconoscimentoLocale(b.win, { chiama: be2.chiama, finePausaMs: 400 });
  let finale = null;
  r.avvia({ onFine: t => { finale = t; }, onErrore: () => {}, onLivello: () => {}, onInterim: () => {} }); await pausa(20);
  b.suona([[2, 0], [1, 0.3], [0.5, 0]]); await pausa(40);
  assert.equal(finale, 'Quando e il parziale?');
  assert.ok(be2.trascritti[0] > 1.3 && be2.trascritti[0] < 2.0, 'a Whisper arrivano il parlato e un margine, non i 2 s di silenzio iniziale: ' + be2.trascritti[0]);
});

test.after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (e) { /* processi in chiusura */ } });

test('config: prompt STT spento di default, un valore esplicito lo attiva, vuoto lo spegne', () => {
  const stt = (envProcesso) => require('../config').carica({ envProcesso, envFile: path.join(os.tmpdir(), 'orbit-inesistente.env') }).settings.stt.prompt;
  assert.strictEqual(stt({}), '');
  assert.strictEqual(stt({ ORBIT_STT_PROMPT: '' }), '');
  assert.strictEqual(stt({ ORBIT_STT_PROMPT: 'Orbit Vosk' }), 'Orbit Vosk');
});

test('diagnostica STT: salva gli ultimi 10 WAV solo con diagnostica e cartella', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-prova-'));
  const invia = async (stt) => {
    const vl = creaVoceLocale({ settings: { stt: Object.assign({ motore: 'whisper' }, stt) }, log: { info() {}, warn() {} }, whisper: { trascrivi: async () => ({ testo: 'x', vuoto: false }), avvia() {}, stato: () => ({}), disponibile: () => true, ferma() {} }, parola: { avvia() {}, stato: () => ({}), disponibile: () => true, ferma() {} } });
    const req = Object.assign(require('stream').Readable.from([wavDi(1)]), { url: '/api/voce/trascrivi', method: 'POST', headers: { 'x-orbit': '1', 'content-type': 'audio/wav' } });
    await vl.gestisci(req, {}, { invia: () => {} });
  };
  try {
    await invia({ diagnostica: false, diagnosticaDir: dir });
    assert.equal(fs.readdirSync(dir).length, 0);
    for (let i = 0; i < 12; i++) { await invia({ diagnostica: true, diagnosticaDir: dir }); await new Promise(r => setTimeout(r, 2)); }
    assert.equal(fs.readdirSync(dir).length, 10);
    const c = require('../config').carica({ envProcesso: { ORBIT_STT_DIAGNOSTICA: '1' }, envFile: path.join(dir, 'no.env') }).settings.stt;
    assert.equal(c.diagnosticaDir, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostica STT: la riga riporta picco, RMS massimo e campioni a fondo scala (solo con diagnostica)', async () => {
  const wav = Buffer.from(voce.wav(Int16Array.from({ length: 16000 }, (_, i) => (i % 2 ? 32767 : -16384))));
  for (const diagnostica of [false, true]) {
    const righe = [], log = { info: m => righe.push(m), warn() {} };
    const vl = creaVoceLocale({ settings: { stt: { motore: 'whisper', diagnostica } }, log, whisper: { trascrivi: async () => ({ testo: 'x', vuoto: false }), avvia() {}, stato: () => ({}), disponibile: () => true, ferma() {} }, parola: { avvia() {}, stato: () => ({}), disponibile: () => true, ferma() {} } });
    const req = Object.assign(require('stream').Readable.from([wav]), { url: '/api/voce/trascrivi', method: 'POST', headers: { 'x-orbit': '1', 'content-type': 'audio/wav' } });
    await vl.gestisci(req, {}, { invia: () => {} });
    if (!diagnostica) { assert.equal(righe.length, 0); continue; }
    const d = JSON.parse(righe[0].slice(righe[0].indexOf('{')));
    assert.equal(d.piccoPct, 100); assert.equal(d.campioniClip, 8000); assert.ok(d.rmsMaxPct > 50 && d.rmsMaxPct < 80, String(d.rmsMaxPct));
  }
});
