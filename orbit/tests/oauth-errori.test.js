'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-oauth-errori-'));
process.env.ORBIT_VAULT_PATH = path.join(base, 'vault'); fs.mkdirSync(process.env.ORBIT_VAULT_PATH);
process.env.ORBIT_DATA_DIR = path.join(base, 'dati');
process.env.ORBIT_INDEX_DIR = path.join(base, 'indice');
process.env.ORBIT_ENV_FILE = path.join(base, 'facoltativo.env');
process.env.ORBIT_LOCAL_ENV = path.join(base, 'profilo-assente.env');
process.env.ORBIT_UTENTE = 'Utente sintetico'; process.env.ORBIT_UTENTE_PROFILO = '';
const { classificaErrore } = require('../ai/providers/claude-code');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const config = require('../config');
const { MockProvider } = require('./helpers');
const { errori } = require('../ai/errors');

const AUTH = [
  'Failed to refresh OAuth token', 'Failed to refresh OAuth access token: please try again',
  '401 unauthorized', 'HTTP 401: temporarily unavailable, try again',
  'Invalid bearer token', 'Bearer token has expired',
  'OAuth token expired - please try again', 'OAuth token has expired',
  'OAuth refresh token expired - please try again',
  '{"status":401,"message":"overloaded"}', 'Unauthorized',
  'Not logged in. Please run /login', 'Authentication failed'
];
for (const message of AUTH) test('OAuth: errore fatale senza retry: ' + message, () => {
  const err = classificaErrore(message, 1);
  assert.equal(err.code, 'NOT_LOGGED_IN'); assert.equal(err.fatal, true);
  assert.equal(err.retryable, false); assert.equal(err.codiceUscita, 1);
  assert.match(err.message, /login/); assert.ok(!err.message.includes(message));
});

for (const [message, code, retryable, fatal] of [
  ['Service overloaded, try again', 'OVERLOADED', true, false],
  ['HTTP 503 Service unavailable', 'OVERLOADED', true, false],
  ['HTTP 529 overloaded', 'OVERLOADED', true, false],
  ['HTTP 500 temporarily unavailable', 'OVERLOADED', true, false],
  ['429 rate limit: too many requests', 'LIMITE_ABBONAMENTO', false, true],
  ['OAuth callback temporarily unavailable', 'OVERLOADED', true, false],
  ['Bearer token received; service temporarily unavailable', 'OVERLOADED', true, false],
  ['Unknown model model-4010', 'MODEL_NOT_FOUND', false, false],
  ['Unexpected error 1401', 'BAD_RESPONSE', false, false],
  ["Claude's response exceeded the 401 output token maximum.", 'OUTPUT_TROPPO_LUNGO', false, false]
]) test('OAuth: caso negativo e comportamento esistente: ' + message, () => {
  const err = classificaErrore(message, 1);
  assert.equal(err.code, code); assert.equal(err.retryable, retryable); assert.equal(err.fatal, fatal);
});

function app(provider) {
  const { settings } = config.carica({ envProcesso: process.env, envFile: process.env.ORBIT_ENV_FILE });
  settings.limiti.maxRetryApi = 3;
  return creaApp({ settings, provider, storage: new Storage(':memory:'), tts: {}, voce: {}, cifratura: {}, attendiFn: () => Promise.resolve() });
}
for (const message of ['OAuth token expired - please try again', 'OAuth refresh token expired - please try again']) {
for (const high of [false, true]) test('OAuth: pipeline ' + (high ? 'high' : 'low') + ' senza retry, escalation o risposta non verificata: ' + message, async () => {
  const provider = new MockProvider({ produttore: () => { throw classificaErrore(message, 1); } });
  const a = app(provider), eventi = [];
  try {
    const r = await a.orchestrator.elabora({ messaggio: high ? 'Che dosaggio di farmaco devo prendere?' : 'come va?', onEvent: e => eventi.push(e) });
    assert.equal(r.ok, false); assert.equal(r.codice, 'NOT_LOGGED_IN'); assert.equal(r.testo, undefined);
    assert.equal(provider.chiamate.length, 1);
    assert.ok(!eventi.some(e => ['ritento', 'escalation', 'finale'].includes(e.tipo)));
    if (high) assert.ok(provider.chiamate.every(c => !/haiku/i.test(c.model)));
    assert.ok(!a.storage.messaggi(r.conversazioneId).some(m => m.ruolo === 'assistant'));
  } finally { a.storage.chiudi(); }
});
}

test('OAuth: errore del verificatore high ferma senza consegnare il candidato', async () => {
  const provider = new MockProvider({ produttore: () => 'Per il dosaggio consulta un medico.',
    verificatore: () => { throw classificaErrore('Failed to refresh OAuth token', 1); } });
  const a = app(provider), eventi = [];
  try {
    const r = await a.orchestrator.elabora({ messaggio: 'Che dosaggio di farmaco devo prendere?', onEvent: e => eventi.push(e) });
    assert.equal(r.ok, false); assert.equal(r.testo, undefined);
    assert.equal(provider.conteggio('produttore'), 1); assert.equal(provider.conteggio('verificatore'), 1);
    assert.ok(provider.chiamate.every(c => !/haiku/i.test(c.model)));
    assert.ok(!eventi.some(e => ['ritento', 'escalation', 'finale'].includes(e.tipo)));
  } finally { a.storage.chiudi(); }
});

test('OAuth: TIMEOUT rimane retryable e distinto da autenticazione', () => {
  const err = errori.timeout(); assert.equal(err.code, 'TIMEOUT'); assert.equal(err.retryable, true); assert.equal(err.fatal, false);
});

for (const message of ['HTTP 503 Service unavailable', 'HTTP 529 overloaded', 'Service overloaded, try again']) test('regressione: retry transitorio preservato: ' + message, async () => {
  const provider = new MockProvider({ produttore: ({ n }) => { if (n === 1) throw classificaErrore(message, 1); return 'Ciao! Sto bene, grazie.'; } });
  const a = app(provider), eventi = [];
  try {
    const r = await a.orchestrator.elabora({ messaggio: 'come va?', onEvent: e => eventi.push(e) });
    assert.equal(r.ok, true); assert.equal(provider.conteggio('produttore'), 2);
    assert.ok(eventi.some(e => e.tipo === 'ritento')); assert.ok(!eventi.some(e => e.tipo === 'escalation'));
  } finally { a.storage.chiudi(); }
});

test('regressione B0006: high con solo Haiku resta rifiutato senza chiamate', async () => {
  const provider = new MockProvider({ modelli: [{ id: 'mock-haiku-1', nome: 'Haiku' }] }), a = app(provider);
  try {
    const r = await a.orchestrator.elabora({ messaggio: 'Che dosaggio di farmaco devo prendere?' });
    assert.equal(r.ok, false); assert.equal(r.codice, 'NO_MODEL'); assert.equal(provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});

test('regressione 2A: aritmetica certificata mantiene zero chiamate', async () => {
  const provider = new MockProvider(), a = app(provider);
  try {
    const r = await a.orchestrator.elabora({ messaggio: 'Quanto fa 7 per 8?' });
    assert.equal(r.testo, '56.'); assert.equal(r.chiamateAI, 0); assert.equal(provider.chiamate.length, 0);
  } finally { a.storage.chiudi(); }
});
