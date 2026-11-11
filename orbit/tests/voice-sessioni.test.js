'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/voice');
const { ambienteUI } = require('./performance-ui-fixture');
const scarica = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function browserFinto() {
  const pronunce = [];
  const win = {
    speechSynthesis: { getVoices: () => [{ name: 'Italiana fixture', lang: 'it-IT' }], cancel() { this.onCancel?.(); }, speak: u => pronunce.push(u) },
    SpeechSynthesisUtterance: class { constructor(testo) { this.text = testo; } }
  };
  return { win, pronunce };
}
function localeFinto(motore, attesa = false) {
  const b = browserFinto(), audio = [], frame = new Map(), cancellati = [], revocati = [], pending = [];
  let n = 0;
  const risposta = () => ({ ok: true, blob: async () => ({}) });
  Object.assign(b.win, {
    Audio: class { constructor(url) { this.url = url; audio.push(this); } play() { return Promise.resolve(); } pause() { this.paused = true; } },
    AudioContext: class {
      constructor() { this.state = 'running'; }
      createMediaElementSource() { return { connect() {} }; }
      createAnalyser() { return { frequencyBinCount: 4, connect() {}, getByteTimeDomainData: buf => buf.fill(160) }; }
    },
    URL: { createObjectURL: () => 'blob:fixture-' + ++n, revokeObjectURL: url => revocati.push(url) },
    requestAnimationFrame: cb => { const id = ++n; frame.set(id, cb); return id; },
    cancelAnimationFrame: id => { cancellati.push(id); frame.delete(id); },
    fetch: async url => {
      if (url === '/api/tts/stato') return { ok: true, json: async () => ({ disponibile: true, motore, voce: 'Fixture' }) };
      if (!attesa) return risposta();
      return new Promise((resolve, reject) => pending.push({ completa: () => resolve(risposta()), reject }));
    }
  });
  return { ...b, audio, frame, cancellati, revocati, pending };
}
function conta() {
  const eventi = [];
  return { eventi, opzioni: Object.fromEntries(['onInizio', 'onAudio', 'onBoundary', 'onFine', 'onErrore', 'onRiproduzioneFine', 'onLivello'].map(k => [k, v => eventi.push([k, v])])) };
}
const apiChat = () => Object.fromEntries([
  ['/api/conversations', ['a', 'b', 'c'].map(id => ({ id, titolo: id.toUpperCase(), aggiornata: 1 }))],
  ...['a', 'b', 'c'].map(id => ['/api/conversations/' + id, { messaggi: [{ ruolo: 'assistant', contenuto: 'Risposta ' + id + '.' }] }])
]);
async function ui(api = {}, b = browserFinto()) {
  const voce = V.creaSintesiOrbit(b.win), u = ambienteUI(undefined, { ...apiChat(), ...api });
  if (b.audio) await voce.inizializza();
  await u.scarica();
  u.sintesi.haVoceItaliana = () => true; u.sintesi.supportata = true;
  u.sintesi.parla = (t, o) => voce.parla(t, o); u.sintesi.ferma = () => voce.ferma(); u.sintesi.inCorso = () => voce.inCorso();
  u.win.OrbitCore.crea().impulso = () => {};
  const scegli = async i => { u.elementi.get('listaConv').children[i].children[0].listeners.click(); await u.scarica(); };
  const parla = () => { u.elementi.get('rMeta').children.at(-1).listeners.click(); const p = b.pronunce.at(-1); p.onstart(); return p; };
  const stato = nome => {
    assert.equal(u.win.__orbit.stato().core.nome, nome);
    assert.equal(voce.inCorso(), nome === 'speaking');
    assert.equal(u.elementi.get('btnVoceStop').disabled, nome !== 'speaking');
  };
  return { u, ...b, voce, scegli, parla, stato };
}
const tardive = p => { p.onstart(); p.onboundary(); p.onerror({ error: 'synthesis-failed' }); p.onend(); };

for (const evento of ['onend', 'onerror', 'onstart', 'onboundary']) {
  test('sessioni UI: ' + evento + ' tardivo di A non altera la lettura B', async () => {
    const t = await ui(); await t.scegli(0); const a = t.parla(); t.stato('speaking');
    await t.scegli(1); t.stato('responding'); const b = t.parla();
    a[evento]({ error: 'synthesis-failed' }); t.stato('speaking');
    assert.equal(t.u.elementi.get('suggerimentoVoce').textContent, '');
    b.onend(); t.stato('responding');
    tardive(a); tardive(b); t.stato('responding');
    assert.equal(t.pronunce.length, 2); assert.equal(t.u.richieste.length, 0);
    assert.equal(t.u.chiamateApi.some(c => c.url === '/api/preferences'), false);
  });
}

test('sessioni UI: Stop invalida B anche senza nuove riproduzioni', async () => {
  const t = await ui(); await t.scegli(0); const b = t.parla();
  t.u.elementi.get('btnVoceStop').listeners.click(); t.stato('responding');
  tardive(b); t.stato('responding'); assert.equal(t.pronunce.length, 1);
});

test('sessioni UI: tre chat rapide e callback in ordini diversi mantengono C', async () => {
  for (const ordine of [['onend', 'onerror', 'onstart'], ['onstart', 'onend', 'onerror'], ['onerror', 'onstart', 'onend'], ['onend', 'onstart', 'onerror'], ['onstart', 'onerror', 'onend'], ['onerror', 'onend', 'onstart']]) {
    const t = await ui(); await t.scegli(0); const a = t.parla(); await t.scegli(1); const b = t.parla(); await t.scegli(2); const c = t.parla();
    for (const nome of ordine) { b[nome]({ error: 'synthesis-failed' }); a[nome]({ error: 'synthesis-failed' }); t.stato('speaking'); }
    c.onend(); t.stato('responding'); assert.equal(t.pronunce.length, 3); assert.equal(t.u.richieste.length, 0);
  }
});

test('sessioni UI: chat non caricata conserva bozza e ignora callback della voce fermata', async () => {
  const t = await ui({ '/api/conversations/b': () => { throw new TypeError('Rete fixture'); } });
  await t.scegli(0); const a = t.parla(); t.u.elementi.get('input').value = 'Bozza A'; t.u.elementi.get('input').listeners.input({});
  await t.scegli(1); t.stato('error'); tardive(a); t.stato('error');
  assert.equal(t.u.elementi.get('input').value, 'Bozza A'); assert.equal(t.pronunce.length, 1); assert.equal(t.u.richieste.length, 0);
});

test('sessioni UI: selezione della stessa chat conserva speaking e Stop', async () => {
  const t = await ui(); await t.scegli(0); const a = t.parla(); await t.scegli(0); t.stato('speaking');
  a.onend(); t.stato('responding'); assert.equal(t.pronunce.length, 1);
});

test('sessioni browser: callback duplicate, confini e fine naturale notificano una sola conclusione', () => {
  const b = browserFinto(), s = V.creaSintesi(b.win), c = conta(); s.parla('Prima. Seconda.', c.opzioni);
  const [prima, ultima] = b.pronunce;
  prima.onstart(); prima.onstart(); prima.onboundary(); prima.onend(); prima.onboundary(); prima.onstart();
  assert.equal(s.inCorso(), true); ultima.onend(); ultima.onend(); ultima.onerror({ error: 'synthesis-failed' }); ultima.onstart?.();
  assert.equal(s.inCorso(), false);
  assert.deepEqual(c.eventi.map(e => e[0]), ['onInizio', 'onAudio', 'onBoundary', 'onRiproduzioneFine', 'onFine']);
});

test('sessioni browser: cancel sincrono e sostituzione invalidano A prima delle sue callback', () => {
  const b = browserFinto(), s = V.creaSintesi(b.win), a = conta(), c = conta(); s.parla('A.', a.opzioni); const old = b.pronunce[0]; old.onstart();
  b.win.speechSynthesis.onCancel = () => tardive(old);
  s.parla('B.', c.opzioni); const current = b.pronunce[1]; current.onstart();
  assert.equal(s.inCorso(), true); assert.deepEqual(a.eventi.map(e => e[0]), ['onInizio', 'onAudio']);
  s.ferma(); tardive(current); assert.equal(s.inCorso(), false); assert.deepEqual(c.eventi.map(e => e[0]), ['onInizio', 'onAudio']);
});

test('sessioni browser: errore corrente e cancellazione terminano una sola volta senza bloccare', () => {
  for (const error of ['synthesis-failed', 'canceled', 'interrupted']) {
    const b = browserFinto(), s = V.creaSintesi(b.win), c = conta(); s.parla('Attiva.', c.opzioni); const p = b.pronunce[0]; p.onstart(); p.onerror({ error });
    assert.equal(s.inCorso(), false); tardive(p); assert.equal(c.eventi.filter(e => e[0] === 'onFine').length, 1);
    assert.equal(c.eventi.filter(e => e[0] === 'onErrore').length, error === 'synthesis-failed' ? 1 : 0);
  }
});

test('sessioni browser: callback che avvia B impedisce la notifica successiva di A', () => {
  const b = browserFinto(), s = V.creaSintesi(b.win); let fineA = 0;
  s.parla('A.', { onRiproduzioneFine: () => s.parla('B.'), onFine: () => fineA++ }); b.pronunce[0].onend();
  assert.equal(s.inCorso(), true); assert.equal(fineA, 0); b.pronunce[1].onend(); assert.equal(s.inCorso(), false);
});

for (const motore of ['Piper', 'ElevenLabs']) {
  test('sessioni ' + motore + ': eventi audio obsoleti non azzerano livello o frame di B', async () => {
    const f = localeFinto(motore), s = V.creaSintesiOrbit(f.win), a = conta(), b = conta(); await s.inizializza();
    s.parla('Audio A.', a.opzioni); await scarica(); const old = f.audio[0]; old.onplaying(); s.ferma();
    s.parla('Audio B.', b.opzioni); await scarica(); const current = f.audio[1]; current.onplaying();
    const eventiB = b.eventi.length, eventiA = a.eventi.length, frameB = [...f.frame.keys()].at(-1);
    old.onended(); old.onerror(); old.onplaying(); old.onpause(); await scarica();
    assert.equal(s.inCorso(), true); assert.equal(a.eventi.length, eventiA); assert.equal(b.eventi.length, eventiB); assert.equal(f.frame.has(frameB), true);
    current.onended(); await scarica(); const conclusione = b.eventi.length; current.onended(); current.onerror(); current.onplaying(); await scarica();
    assert.equal(s.inCorso(), false); assert.equal(b.eventi.length, conclusione); assert.equal(b.eventi.filter(e => e[0] === 'onFine').length, 1);
    assert.equal(f.revocati.length, 2); assert.equal(f.audio.length, 2);
  });
  test('sessioni ' + motore + ': risposta TTS tardiva o rifiutata non avvia audio dopo Stop', async () => {
    for (const rifiuta of [false, true]) {
      const f = localeFinto(motore, true), s = V.creaSintesiOrbit(f.win), a = conta(), b = conta(); await s.inizializza();
      s.parla('A.', a.opzioni); s.ferma(); s.parla('B.', b.opzioni);
      f.pending[1].completa(); await scarica(); f.audio[0].onplaying();
      if (rifiuta) f.pending[0].reject(new Error('TTS fixture')); else f.pending[0].completa(); await scarica();
      assert.equal(s.inCorso(), true); assert.equal(f.audio.length, 1); assert.deepEqual(a.eventi, []);
      s.ferma(); f.audio[0].onpause(); f.audio[0].onended(); await scarica(); assert.equal(s.inCorso(), false);
      assert.equal(b.eventi.some(e => e[0] === 'onFine' || e[0] === 'onErrore'), false);
    }
  });
}

for (const motore of ['Piper', 'ElevenLabs']) {
  test('sessioni UI ' + motore + ': callback A, fine B e Stop mantengono i controlli corretti', async () => {
    const f = localeFinto(motore), t = await ui({}, f);
    await t.scegli(0); t.u.elementi.get('rMeta').children.at(-1).listeners.click(); await scarica(); const a = f.audio[0]; a.onplaying(); t.stato('speaking');
    await t.scegli(1); t.stato('responding'); t.u.elementi.get('rMeta').children.at(-1).listeners.click(); await scarica(); const b = f.audio[1]; b.onplaying();
    a.onerror(); a.onended(); a.onplaying(); a.onpause(); await scarica(); t.stato('speaking');
    b.onended(); await scarica(); t.stato('responding');
    t.u.elementi.get('rMeta').children.at(-1).listeners.click(); await scarica(); const c = f.audio[2]; c.onplaying(); t.stato('speaking');
    t.u.elementi.get('btnVoceStop').listeners.click(); c.onpause(); c.onended(); c.onerror(); await scarica(); t.stato('responding');
    assert.equal(f.audio.length, 3); assert.equal(t.u.richieste.length, 0);
    assert.equal(t.u.chiamateApi.some(x => x.url === '/api/preferences'), false);
  });
}

test('sessioni locali: cancellazione nella callback iniziale non avvia riproduzione', async () => {
  for (const callback of ['onSintesi', 'onInizio']) {
    const f = localeFinto('Piper'), s = V.creaSintesiOrbit(f.win); await s.inizializza();
    s.parla('Audio sintetico.', { [callback]: () => s.ferma() }); await scarica();
    assert.equal(s.inCorso(), false); assert.equal(f.audio.length, 0);
  }
});

test('sessioni locali: fine naturale che avvia B non invoca onFine di A', async () => {
  const f = localeFinto('ElevenLabs'), s = V.creaSintesiOrbit(f.win); await s.inizializza(); let fineA = 0;
  s.parla('A.', { onRiproduzioneFine: () => s.parla('B.'), onFine: () => fineA++ }); await scarica(); f.audio[0].onended(); await scarica();
  assert.equal(fineA, 0); assert.equal(s.inCorso(), true); assert.equal(f.audio.length, 2);
  f.audio[1].onended(); await scarica(); assert.equal(s.inCorso(), false);
});

test('sessioni browser: Stop durante onInizio non notifica audio o accoda frasi successive', () => {
  const b = browserFinto(), s = V.creaSintesi(b.win); let audio = 0;
  b.win.speechSynthesis.speak = p => { b.pronunce.push(p); p.onstart?.(); };
  s.parla('Prima. Seconda.', { onInizio: () => s.ferma(), onAudio: () => audio++ });
  assert.equal(s.inCorso(), false); assert.equal(audio, 0); assert.equal(b.pronunce.length, 1);
});

test('sessioni browser: testo vuoto termina senza nuove riproduzioni e invalida A', () => {
  for (const testo of ['', '   ']) {
    const b = browserFinto(), s = V.creaSintesi(b.win); let fine = 0;
    s.parla('A.'); const a = b.pronunce[0]; s.parla(testo, { onFine: () => fine++ }); tardive(a);
    assert.equal(s.inCorso(), false); assert.equal(fine, 1); assert.equal(b.pronunce.length, 1);
  }
});
