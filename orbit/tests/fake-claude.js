'use strict';
// Falso eseguibile `claude` per i test: stessa interfaccia da riga di comando dell'uso che fa Orbit
// (`claude auth status` e `claude -p ... --output-format json`), senza rete, senza abbonamento e senza consumare nulla.
// Comportamento scelto con variabili ORBIT_FAKE_* (non filtrate dal provider); registra ogni chiamata in ORBIT_FAKE_LOG.
const fs = require('fs');
const args = process.argv.slice(2);
const modo = process.env.ORBIT_FAKE_MODE || 'ok';

function registra(extra) {
  if (!process.env.ORBIT_FAKE_LOG) return;
  const sospette = Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(k));
  fs.appendFileSync(process.env.ORBIT_FAKE_LOG, JSON.stringify(Object.assign({ args, variabiliApi: sospette, cwd: process.cwd() }, extra)) + '\n');
}

if (args[0] === '--version') { process.stdout.write('9.9.9 (Falso Claude Code)'); process.exit(0); }

if (args[0] === 'auth' && args[1] === 'status') {
  registra({ comando: 'auth status' });
  const tipo = process.env.ORBIT_FAKE_AUTH || 'abbonamento';
  const base = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' };
  if (tipo === 'api') Object.assign(base, { authMethod: 'api_key' });
  if (tipo === 'bedrock') Object.assign(base, { apiProvider: 'bedrock' });
  if (tipo === 'fuori') Object.assign(base, { loggedIn: false });
  process.stdout.write(tipo === 'rotto' ? 'non json' : JSON.stringify(base));
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', () => {
  registra({ comando: 'p', stdin });
  const model = args[args.indexOf('--model') + 1];
  const risposta = (testo, extra) => process.stdout.write(JSON.stringify(Object.assign({
    type: 'result', subtype: 'success', is_error: false, result: testo, stop_reason: 'end_turn', session_id: 'sess-finta',
    total_cost_usd: 0.002, usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 0, output_tokens: 25 },
    modelUsage: { ['claude-' + model + '-finto']: { inputTokens: 10, outputTokens: 25 } }
  }, extra)));
  if (process.env.ORBIT_FAKE_BAD_MODEL && process.env.ORBIT_FAKE_BAD_MODEL === model) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'There\'s an issue with the selected model (' + model + '). It may not exist.' })); process.exit(1); }
  if (modo === 'esce2') { process.stderr.write('errore interno del processo'); process.exit(2); }
  if (modo === 'enorme') { process.stdout.write('x'.repeat(5000)); return setTimeout(() => process.exit(0), 3000); }
  if (modo === 'lento') return setTimeout(() => risposta('troppo tardi'), 5000);
  if (modo === 'limite') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.' })); process.exit(1); }
  if (modo === 'nologin') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in - Please run /login' })); process.exit(1); }
  if (modo === 'modello') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'There\'s an issue with the selected model (' + model + '). It may not exist or you may not have access to it.' })); process.exit(1); }
  if (modo === 'rotto') { process.stdout.write('{non json'); process.exit(0); }
  if (modo === 'tronca') return risposta('Risposta tagliata a meta', { stop_reason: 'max_tokens' });
  return risposta(process.env.ORBIT_FAKE_REPLY || 'Risposta di prova scritta in italiano dal falso Claude Code.');
});
