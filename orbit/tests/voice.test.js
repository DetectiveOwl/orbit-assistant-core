'use strict';
// Voce locale (Piper), endpoint /api/tts, sintesi a blocchi, normalizzazione del testo e parola di attivazione "Orbit".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../public/voice');
const MD = require('../public/markdown');
const { PiperTTS } = require('../voice/piper');
const { creaServer } = require('../server');
const { MockProvider, appProva } = require('./helpers');

const FALSO_PIPER = path.join(__dirname, 'fake-piper.js');
function piperFinto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-piper-'));
  const modello = path.join(dir, 'modello.onnx'); fs.writeFileSync(modello, 'x');
  return new PiperTTS({ dir, exe: process.execPath, binArgs: [FALSO_PIPER], modello });
}
const attendi = ms => new Promise(r => setTimeout(r, ms));

// ---------- Piper lato server ----------
test('piper: un solo processo persistente, richieste serializzate e audio cancellato dal disco', async () => {
  const t = piperFinto();
  assert.equal(t.disponibile(), true);
  const [a, b, c] = await Promise.all([t.sintetizza('Prima frase.'), t.sintetizza('Seconda frase.'), t.sintetizza('Terza.')]);
  assert.match(a.toString(), /Prima frase/); assert.match(b.toString(), /Seconda frase/); assert.match(c.toString(), /Terza/);
  assert.ok(t.proc);                                   // processo ancora vivo per le prossime frasi
  assert.deepEqual(fs.readdirSync(t.cartellaOut), []); // nessun file audio rimasto
  t.chiudi();
});

test('piper: testo vuoto, voce non installata e processo muto sono errori chiari', async () => {
  const t = piperFinto();
  await assert.rejects(t.sintetizza('   '), /vuoto/i);
  const assente = new PiperTTS({ dir: path.join(os.tmpdir(), 'non-esiste-orbit') });
  assert.equal(assente.disponibile(), false);
  await assert.rejects(assente.sintetizza('ciao'), /non e installata/);
  t.chiudi();
});

test('piper: i caratteri di controllo non passano e il testo viene limitato', async () => {
  const t = piperFinto();
  let wav;
  try { wav = await t.sintetizza('ciao\u0000\u0007 mondo ' + 'x'.repeat(2000)); } catch (e) { t.chiudi(); throw e; }
  try {
    assert.ok(!/\u0007/.test(wav.toString()));
    assert.ok(wav.length < 900);
  } finally { t.chiudi(); }
});

// ---------- endpoint ----------
async function conServer(app, fn) {
  const prima = creaServer(app, { port: 0 });
  await new Promise(r => prima.listen(0, '127.0.0.1', r));
  const port = prima.address().port; prima.close();
  const s = creaServer(app, { port });
  await new Promise(r => s.listen(port, '127.0.0.1', r));
  try { await fn('http://localhost:' + port); } finally { s.closeAllConnections(); await new Promise(r => s.close(r)); }
}
const H = { 'X-Orbit': '1', 'Content-Type': 'application/json' };

test('server: /api/tts restituisce audio WAV, valida l input e dichiara se la voce manca', async () => {
  const tts = piperFinto();
  const app = Object.assign(appProva({ provider: new MockProvider() }), { tts });
  await conServer(app, async base => {
    const st = await (await fetch(base + '/api/tts/stato', { headers: { 'X-Orbit': '1' } })).json();
    assert.equal(st.disponibile, true);
    const r = await fetch(base + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ testo: 'Ciao Marco.' }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/wav');
    assert.match(Buffer.from(await r.arrayBuffer()).toString(), /Ciao Marco/);
    assert.equal((await fetch(base + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ testo: '' }) })).status, 400);
    assert.equal((await fetch(base + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ testo: 'x'.repeat(3000) }) })).status, 400);
    assert.equal((await fetch(base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"testo":"ciao"}' })).status, 403);
  });
  tts.chiudi();
  const senza = Object.assign(appProva({ provider: new MockProvider() }), { tts: new PiperTTS({ dir: path.join(os.tmpdir(), 'non-esiste-orbit') }) });
  await conServer(senza, async base => {
    const r = await fetch(base + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ testo: 'ciao' }) });
    assert.equal(r.status, 503);
    assert.match((await r.json()).errore, /installa-voce/);
  });
});

// ---------- testo per la voce ----------
test('voce: il testo viene scritto come si pronuncia e a blocchi, con il primo corto', () => {
  assert.equal(MD.perVoce('Oggi hai **4h30**: A3 per 1h e 45 min, poi il 20%.'), 'Oggi hai 4 ore e 30: A 3 per 1 ora e 45 minuti, poi il 20 per cento.');
  const b = V.spezzaPerVoce('Ciao Marco. Oggi hai quattro ore e mezza di studio, divise in quattro blocchi. Il primo e la matrice inversa. Poi gli spazi vettoriali.');
  assert.ok(b[0].length >= 25 && b[0].length < 100);
  assert.ok(b.length >= 2);
  assert.equal(b.join(' ').replace(/\s+/g, ' '), 'Ciao Marco. Oggi hai quattro ore e mezza di studio, divise in quattro blocchi. Il primo e la matrice inversa. Poi gli spazi vettoriali.');
  assert.ok(V.spezzaPerVoce('parola, '.repeat(120)).every(x => x.length <= 460));
});

// ---------- riproduzione locale a blocchi ----------
function ambienteAudio() {
  const chiamate = [], riprodotti = [];
  class Audio {
    constructor(url) { this.url = url; this.playbackRate = 1; riprodotti.push(this); }
    play() { setTimeout(() => this.onended && this.onended(), 15); return Promise.resolve(); }
    pause() { this.fermato = true; this.onpause && this.onpause(); }
  }
  const win = {
    Audio, URL: { createObjectURL: () => 'blob:x' + riprodotti.length, revokeObjectURL() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, speechSynthesis: null,
    fetch: async (url, init) => {
      if (url === '/api/tts/stato') return { ok: true, json: async () => ({ disponibile: true, voce: 'Paola (Piper, locale)' }) };
      const { testo, velocita } = JSON.parse(init.body); chiamate.push(testo); (win.velocitaRichieste = win.velocitaRichieste || []).push(velocita);
      return { ok: true, blob: async () => ({ testo }) };
    }
  };
  return { win, chiamate, riprodotti };
}

test('sintesi locale: legge i blocchi in ordine, scarica in anticipo e rispetta la velocita', async () => {
  const { win, chiamate, riprodotti } = ambienteAudio();
  const s = V.creaSintesiOrbit(win);
  await s.inizializza();
  assert.equal(s.haVoceItaliana(), true);
  assert.equal(s.supportata, true);
  assert.equal(s.voci()[0].name, V.VOCE_LOCALE);
  let inizio = 0, fine = 0;
  s.parla('Ciao Marco. Oggi hai quattro ore e mezza di studio. Il primo blocco e la matrice inversa, poi gli spazi vettoriali e i sottospazi.', { voce: '', velocita: '1.2', onInizio: () => inizio++, onFine: () => fine++ });
  await attendi(200);
  assert.equal(inizio, 1); assert.equal(fine, 1);
  assert.equal(riprodotti.length, chiamate.length);
  assert.ok(riprodotti.every(a => a.playbackRate === 1));            // nessun allungamento nel browser
  assert.ok(win.velocitaRichieste.every(x => x === 1.2));           // la velocita la applica Piper
  assert.equal(chiamate[0], 'Ciao Marco. Oggi hai quattro ore e mezza di studio.');
});

test('sintesi locale: ferma() interrompe subito e non legge i blocchi successivi', async () => {
  const { win, riprodotti } = ambienteAudio();
  const s = V.creaSintesiOrbit(win); await s.inizializza();
  let fine = 0;
  s.parla('Prima frase abbastanza lunga da essere un blocco. Seconda frase abbastanza lunga da essere un altro blocco. Terza frase finale lunga abbastanza.', { onFine: () => fine++ });
  await attendi(5);
  s.ferma();
  await attendi(150);
  assert.equal(s.inCorso(), false);
  assert.ok(riprodotti.length <= 1);
  assert.equal(fine, 0);
});

test('sintesi locale: se la voce locale fallisce lo dice e non cambia voce di nascosto', async () => {
  const { win } = ambienteAudio();
  const base = win.fetch;
  win.fetch = async (u, i) => (u === '/api/tts' ? { ok: false, status: 502, json: async () => ({ errore: 'Piper fermo' }) } : base(u, i));
  const s = V.creaSintesiOrbit(win); await s.inizializza();
  let errore = null;
  s.parla('Ciao Marco, questa e una prova.', { onErrore: m => { errore = m; } });
  await attendi(60);
  assert.match(errore, /Piper fermo/);
});

// ---------- parola di attivazione ----------
test('attivazione: riconosce Orbit e separa il comando', () => {
  assert.deepEqual(V.estraiComando('Orbit cosa devo fare oggi'), { attivata: true, comando: 'cosa devo fare oggi' });
  assert.deepEqual(V.estraiComando('ehi, orbit, riassumimi FAM'), { attivata: true, comando: 'riassumimi FAM' });
  assert.deepEqual(V.estraiComando('Orbit'), { attivata: true, comando: '' });
  assert.deepEqual(V.estraiComando('Orbita: che ore sono?'), { attivata: true, comando: 'che ore sono?' });
  assert.deepEqual(V.estraiComando('orbit una cosa. orbit un altra'), { attivata: true, comando: 'un altra' });
  assert.deepEqual(V.estraiComando('parlo con un amico di altro'), { attivata: false, comando: '' });
  assert.equal(V.estraiComando('il cerchio e l\'orbitale di un elettrone').attivata, false);
});

// Falso SpeechRecognition guidabile dal test: i risultati si accumulano come in una sessione continua del browser.
function ambienteRiconoscimento() {
  const sessioni = [];
  class SR {
    constructor() { sessioni.push(this); this.avviato = false; this.risultati = []; }
    start() { this.avviato = true; this.onstart && this.onstart(); }
    stop() { this.avviato = false; setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.avviato = false; this.abortito = true; this.onend && this.onend(); }
    dici(testo, finale) {
      const ultimo = this.risultati[this.risultati.length - 1];
      let indice;
      if (!ultimo || ultimo.isFinal) { indice = this.risultati.length; this.risultati.push(Object.assign([{ transcript: testo }], { isFinal: finale })); }
      else { indice = this.risultati.length - 1; this.risultati[indice] = Object.assign([{ transcript: testo }], { isFinal: finale }); }
      this.onresult({ resultIndex: indice, results: this.risultati });
    }
  }
  return { win: { webkitSpeechRecognition: SR }, sessioni };
}

function conAttivazione(opz = {}) {
  const { win, sessioni } = ambienteRiconoscimento();
  const ev = { stati: [], attivata: 0, comandi: [], testi: [], errori: [] };
  const a = V.creaParolaBrowser(win, {
    onStato: s => ev.stati.push(s), onAttivata: () => ev.attivata++, onTesto: t => ev.testi.push(t), onComando: c => ev.comandi.push(c), onErrore: m => ev.errori.push(m)
  }, Object.assign({ attesaComandoMs: 60, riavvioMs: 5 }, opz));
  return { a, ev, sessioni };
}

test('attivazione: il parlato senza la parola Orbit viene scartato', () => {
  const { a, ev, sessioni } = conAttivazione();
  a.avvia();
  sessioni[0].dici('sto parlando con un amico di FAM', false);
  sessioni[0].dici('sto parlando con un amico di FAM', true);
  assert.equal(ev.attivata, 0); assert.deepEqual(ev.comandi, []); assert.deepEqual(ev.testi, []);
  assert.equal(ev.stati[ev.stati.length - 1], 'attesa');
  a.ferma();
});

test('attivazione: Orbit e il comando nella stessa frase partono da soli', () => {
  const { a, ev, sessioni } = conAttivazione();
  a.avvia();
  sessioni[0].dici('orbit cosa devo', false);
  assert.equal(ev.attivata, 1);
  assert.equal(ev.testi[ev.testi.length - 1], 'cosa devo');
  sessioni[0].dici('orbit cosa devo fare oggi', true);
  assert.deepEqual(ev.comandi, ['cosa devo fare oggi']);
  assert.equal(ev.stati[ev.stati.length - 1], 'pausa');     // si ferma mentre Orbit lavora
  a.ferma();
});

test('attivazione: Orbit da solo, poi il comando nella frase successiva', () => {
  const { a, ev, sessioni } = conAttivazione({ attesaComandoMs: 500 });
  a.avvia();
  sessioni[0].dici('Orbit', true);
  assert.equal(ev.attivata, 1); assert.deepEqual(ev.comandi, []);
  assert.equal(ev.stati[ev.stati.length - 1], 'attivata');
  sessioni[0].dici('riassumi la lezione di analisi', true);
  assert.deepEqual(ev.comandi, ['riassumi la lezione di analisi']);
  a.ferma();
});

test('attivazione: se dopo Orbit non segue nulla torna in attesa senza inviare niente', async () => {
  const { a, ev, sessioni } = conAttivazione({ attesaComandoMs: 30 });
  a.avvia();
  sessioni[0].dici('Orbit', true);
  await attendi(80);
  assert.deepEqual(ev.comandi, []);
  assert.equal(ev.stati[ev.stati.length - 1], 'attesa');
  a.ferma();
});

test('attivazione: pausa e ripresa, riavvio automatico a fine sessione e stop esplicito', async () => {
  const { a, ev, sessioni } = conAttivazione();
  a.avvia();
  sessioni[0].onend();                                  // il browser chiude la sessione continua: Orbit la riapre
  await attendi(30);
  assert.equal(sessioni.length, 2);
  a.pausa();
  assert.ok(sessioni[1].abortito);
  await attendi(30);
  assert.equal(sessioni.length, 2);                      // in pausa non riparte
  a.riprendi();
  await attendi(30);
  assert.equal(sessioni.length, 3);
  a.ferma();
  assert.equal(ev.stati[ev.stati.length - 1], 'spento');
  await attendi(30);
  assert.equal(sessioni.length, 3);
});

test('attivazione: permesso negato spegne l ascolto con un messaggio chiaro', () => {
  const { a, ev, sessioni } = conAttivazione();
  a.avvia();
  sessioni[0].onerror({ error: 'not-allowed' });
  assert.equal(a.attiva(), false);
  assert.match(ev.errori[0], /permesso al microfono/i);
  assert.equal(ev.stati[ev.stati.length - 1], 'errore');
});

test('attivazione: senza riconoscimento nel browser non parte e spiega perche', () => {
  const ev = [];
  const a = V.creaParolaBrowser({}, { onErrore: m => ev.push(m) });
  assert.equal(a.supportata, false);
  assert.equal(a.avvia(), false);
  assert.match(ev[0], /Chrome/);
});

test('voce: elenchi e percorsi diventano parlato, le righe delle fonti non si leggono', () => {
  const t = MD.perVoce('Oggi hai **4h30**:\n1. A3, matrice inversa (1h)\n2. A4, spazi vettoriali (1h30)\nNote usate: scadenze/parziali.md e outputs/piano-2026-10-11.md\nVedi anche scadenze/piano-di-studio.md per i dettagli.');
  assert.ok(!/\d\.\s|\.md|Note usate/.test(t));
  assert.match(t, /^Oggi hai 4 ore e 30: A 3, matrice inversa \(1 ora\)\. A 4, spazi vettoriali \(1 ora e 30\)\./);
  assert.match(t, /le tue note per i dettagli\.$/);
});

test('piper: la velocita si applica nativamente e il processo si riavvia solo se cambia', async () => {
  const t = piperFinto();
  try {
    await t.sintetizza('Prima frase.', { velocita: 1 });
    const pid1 = t.proc.pid; assert.equal(t.lsCorrente, 1);
    await t.sintetizza('Seconda frase.', { velocita: 1 });
    assert.equal(t.proc.pid, pid1);                       // stessa velocita: stesso processo
    await t.sintetizza('Terza frase.', { velocita: 1.25 });
    assert.equal(t.lsCorrente, 0.8);                      // 1 / 1.25
    assert.notEqual(t.proc.pid, pid1);                    // nuova velocita: nuovo processo
    await t.sintetizza('Quarta.', { velocita: 9 });
    assert.equal(t.lsCorrente, 0.65); // limite inferiore del length_scale
  } finally { t.chiudi(); }
});
