'use strict';
// Falso `claude` per la modalita persistente: parla il protocollo stream-json (una riga JSON per turno in ingresso, eventi in uscita)
// senza rete, senza abbonamento e senza consumare nulla. Senza --input-format si comporta come tests/fake-claude.js (sistema tradizionale).
// Comportamento scelto con ORBIT_FAKE_STREAM (ok, crash, protocollo, tooluse, errore, muto, doppio, extraturno) e registrato in ORBIT_FAKE_LOG.
const fs = require('fs');
const args = process.argv.slice(2);
if (!args.includes('--input-format')) { require('./fake-claude.js'); return; }

const modo = process.env.ORBIT_FAKE_STREAM || 'ok';
const slash = !args.includes('--disable-slash-commands');
const model = args[args.indexOf('--model') + 1];
const ritardoResult = Number(process.env.ORBIT_FAKE_RESULT_MS || 60);
const ritardoRisposta = Number(process.env.ORBIT_FAKE_RISPOSTA_MS || 15);
const log = extra => {
  if (!process.env.ORBIT_FAKE_LOG) return;
  const sospette = Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(k));
  fs.appendFileSync(process.env.ORBIT_FAKE_LOG, JSON.stringify(Object.assign({ pid: process.pid, comando: 'stream', variabiliApi: sospette, cwd: process.cwd() }, extra)) + '\n');
};
log({ evento: 'avvio', args });
if (modo === 'uscita') { log({ evento: 'uscita-allo-avvio' }); process.exit(1); }

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let storia = [];       // i turni ricevuti dall'ultimo /clear: serve a provare che nessuna conversazione si mescola
let buf = '', n = 0;

function risposta(contenuto) {
  const testo = process.env.ORBIT_FAKE_REPLY || ('eco[' + storia.length + ']:' + String(contenuto).replace(/\s+/g, ' ').slice(-60) + '|pid:' + process.pid + '|modello:' + model);
  const usage = { input_tokens: 12, cache_creation_input_tokens: 80, cache_read_input_tokens: 0, output_tokens: 20 };
  out({ type: 'system', subtype: 'init', session_id: 's' });
  if (modo === 'errore') return out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.', num_turns: 1 });
  if (modo === 'protocollo') return process.stdout.write('questo non e json\n');
  if (modo === 'muto') return;
  setTimeout(() => {
    out({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-' + model + '-finto', usage } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    const meta = Math.ceil(testo.length / 2);
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: testo.slice(0, meta) } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: testo.slice(meta) } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: testo }] } });
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: modo === 'tooluse' ? 'tool_use' : 'end_turn' }, usage } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    if (modo === 'doppio') {
      out({ type: 'stream_event', event: { type: 'message_start', message: { model: 'x', usage } } });
    }
    setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: testo, num_turns: modo === 'extraturno' ? 2 : 1, usage, total_cost_usd: 0.001 }), ritardoResult);
  }, ritardoRisposta);
}

// ORBIT_FAKE_AVVIO_MS: simula un avvio lento (il processo non legge stdin per quel tempo): serve a provare le richieste mentre il processo non e ancora pronto
if (Number(process.env.ORBIT_FAKE_AVVIO_MS)) { const fine = Date.now() + Number(process.env.ORBIT_FAKE_AVVIO_MS); while (Date.now() < fine) { /* attesa attiva voluta */ } }
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const riga = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!riga.trim()) continue;
    const m = JSON.parse(riga); const contenuto = m.message && m.message.content;
    n++;
    if (typeof contenuto === 'string' && contenuto.trim() === '/clear' && slash) {
      storia = []; log({ evento: 'clear' });
      out({ type: 'system', subtype: 'conversation_reset' });
      setTimeout(() => out({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0 }), 20);
      continue;
    }
    if (modo === 'crash' && n >= 1) { log({ evento: 'crash', contenuto }); process.exit(3); }
    storia.push(contenuto);
    log({ evento: 'messaggio', contenuto, turniInStoria: storia.length, slash });
    risposta(contenuto);
  }
});
process.stdin.on('end', () => process.exit(0));
