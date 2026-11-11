'use strict';
// Falso whisper-server per i test: stessa riga di comando (--port), GET / e POST /inference con risposta verbose_json.
// Il testo restituito dipende dalla durata dell'audio, cosi i test controllano anche cosa arriva al server (audio_ctx, lingua).
const http = require('http');
const args = process.argv.slice(2);
const porta = Number(args[args.indexOf('--port') + 1]);
const ritardo = Number(process.env.FAKE_WHISPER_RITARDO || 0);
let richieste = 0;
http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); return res.end('ok'); }
  const parti = [];
  req.on('data', d => parti.push(d));
  req.on('end', () => {
    richieste++;
    const corpo = Buffer.concat(parti).toString('latin1');
    const campo = n => { const m = corpo.match(new RegExp('name="' + n + '"\\r\\n\\r\\n([^\\r]*)')); return m ? m[1] : null; };
    const testo = process.env.FAKE_WHISPER_ECO_PROMPT ? ' ' + (campo('prompt') === null ? 'senza prompt' : 'prompt:' + campo('prompt')) : (process.env.FAKE_WHISPER_TESTO || ' Orbit, cosa devo fare oggi?');
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: testo, language: 'italian', segments: [{ text: testo, avg_logprob: Number(process.env.FAKE_WHISPER_LOGPROB || -0.3), no_speech_prob: Number(process.env.FAKE_WHISPER_NESSUN_PARLATO || 0.01) }], richieste, audio_ctx: campo('audio_ctx'), args }));
    }, ritardo);
  });
}).listen(porta, '127.0.0.1');
