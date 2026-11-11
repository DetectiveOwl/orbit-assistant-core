'use strict';
// ElevenLabs con servizio finto (nessuna rete, nessun credito) e ripiego automatico su Piper.
const test = require('node:test');
const assert = require('node:assert');
const { ElevenLabsTTS, VoceTTS } = require('../voice/elevenlabs');

function servizio({ stato = 200, usati = 0, limite = 100000, corpo = 'MP3' } = {}) {
  const chiamate = [];
  const fetchFn = async (url, init) => {
    chiamate.push({ url, init });
    if (url.endsWith('/user/subscription')) return { ok: true, status: 200, json: async () => ({ character_count: usati, character_limit: limite }) };
    if (stato !== 200) return { ok: false, status: stato, text: async () => (stato === 401 ? '{"detail":{"status":"quota_exceeded"}}' : 'errore'), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(corpo) };
  };
  return { fetchFn, chiamate };
}
const eleven = (s, extra = {}) => new ElevenLabsTTS(Object.assign({ chiave: () => 'chiave-finta', voceId: 'voce1', fetchFn: s.fetchFn }, extra));
const piperFinto = (disponibile = true) => ({ disponibile: () => disponibile, stato: () => ({ disponibile, voce: 'Paola', motore: 'Piper' }), sintetizza: async () => Buffer.from('WAV'), chiudi() {}, scalda() {} });

test('elevenlabs: invia testo, modello e velocita, restituisce MP3 e conta i caratteri', async () => {
  const s = servizio(); const e = eleven(s, { modello: 'eleven_flash_v2_5' });
  const mp3 = await e.sintetizza('Ciao Marco.', { velocita: 2 });
  assert.equal(mp3.toString(), 'MP3');
  const r = s.chiamate.find(c => c.url.includes('/text-to-speech/voce1'));
  assert.match(r.url, /output_format=mp3/);
  const j = JSON.parse(r.init.body);
  assert.equal(j.text, 'Ciao Marco.'); assert.equal(j.model_id, 'eleven_flash_v2_5'); assert.equal(j.language_code, 'it'); assert.equal(j.voice_settings.speed, 1.2);
  await e.sintetizza('Ciao.'); assert.equal(JSON.parse(s.chiamate.filter(c => c.url.includes('/text-to-speech/')).pop().init.body).voice_settings.speed, undefined);
  assert.equal(e.quota.usati, 16);
});

test('elevenlabs: oltre 1,2x l API non arriva e il resto viene dichiarato per il browser', async () => {
  const s = servizio(); const e = eleven(s);
  const mp3 = await e.sintetizza('Ciao.', { velocita: 1.5 });
  assert.equal(JSON.parse(s.chiamate.find(c => c.url.includes('/text-to-speech/')).init.body).voice_settings.speed, 1.2);
  assert.equal(mp3.residua, 1.25);
  assert.equal((await e.sintetizza('Ciao.', { velocita: 1 })).residua, 1);
});

test('elevenlabs: la lingua forzata non si invia ai modelli che non la accettano', async () => {
  const s = servizio(); await eleven(s).sintetizza('Ciao.');
  assert.equal(JSON.parse(s.chiamate.find(c => c.url.includes('/text-to-speech/')).init.body).language_code, undefined);
});

test('elevenlabs: crediti esauriti o tetto mensile superato, senza chiamare la sintesi', async () => {
  const s = servizio({ usati: 99995, limite: 100000 });
  await assert.rejects(eleven(s).sintetizza('Questa frase supera il limite.'), /esauriti/);
  assert.ok(!s.chiamate.some(c => c.url.includes('/text-to-speech/')));
  const s2 = servizio({ usati: 50, limite: 100000 });
  await assert.rejects(eleven(s2, { tettoMese: 60 }).sintetizza('Questa frase supera il tetto.'), /esauriti/);
});

test('elevenlabs: errori del servizio sospendono il motore e il messaggio non contiene la chiave', async () => {
  const s = servizio({ stato: 401 }); const e = eleven(s);
  await assert.rejects(e.sintetizza('Ciao.'), err => /401/.test(err.message) && !/chiave-finta/.test(err.message));
  assert.equal(e.pronta(), false);
  assert.ok(!JSON.stringify(e.stato()).includes('chiave-finta'));
});

test('voce: senza chiave o senza voce usa Piper', async () => {
  const s = servizio();
  const v = new VoceTTS({ piper: piperFinto(), eleven: new ElevenLabsTTS({ chiave: () => '', voceId: 'v', fetchFn: s.fetchFn }) });
  assert.equal((await v.sintetizza('Ciao.')).toString(), 'WAV');
  assert.equal(v.stato().ripiego, true);
  assert.equal(s.chiamate.length, 0);
  const v2 = new VoceTTS({ piper: piperFinto(), eleven: eleven(s, { voceId: '' }) });
  assert.equal((await v2.sintetizza('Ciao.')).toString(), 'WAV');
});

test('voce: con la chiave usa ElevenLabs (audio/mpeg); se il servizio fallisce ripiega su Piper e per un po non lo richiama', async () => {
  const ok = servizio(); const v = new VoceTTS({ piper: piperFinto(), eleven: eleven(ok) });
  const b = await v.sintetizza('Ciao.'); assert.equal(b.toString(), 'MP3'); assert.equal(b.tipo, 'audio/mpeg');
  assert.equal(v.stato().motore, 'ElevenLabs (cloud)');
  const ko = servizio({ stato: 500 }); const w = new VoceTTS({ piper: piperFinto(), eleven: eleven(ko) });
  assert.equal((await w.sintetizza('Ciao.')).toString(), 'WAV');
  const n = ko.chiamate.length;
  assert.equal((await w.sintetizza('Ancora.')).toString(), 'WAV');
  assert.equal(ko.chiamate.length, n);                  // sospeso: nessun nuovo tentativo (e nessun nuovo costo)
  const rete = new VoceTTS({ piper: piperFinto(), eleven: new ElevenLabsTTS({ chiave: () => 'k', voceId: 'v', fetchFn: async () => { throw new Error('ECONNREFUSED'); } }) });
  assert.equal((await rete.sintetizza('Ciao.')).toString(), 'WAV');
});

test('voce: se anche Piper manca l errore di ElevenLabs arriva al chiamante', async () => {
  const v = new VoceTTS({ piper: piperFinto(false), eleven: eleven(servizio({ stato: 500 })) });
  await assert.rejects(v.sintetizza('Ciao.'), /500/);
});
