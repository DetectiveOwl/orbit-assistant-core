'use strict';
// Configurazione host di Smart Inbox: spenta di default, scope solo da file indicato dall host, scope non valido = integrazione spenta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { MockProvider, settingsProva } = require('./helpers');

const carica = extra => config.carica({ envProcesso: Object.assign({ ORBIT_ENV_FILE: 'C:/inesistente/.env', ORBIT_DATA_DIR: path.join(os.tmpdir(), 'orbit-test-dati') }, extra), envFile: 'C:/inesistente/.env' });
const scrivi = testo => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-si-cfg-')), 'ambito.json'); fs.writeFileSync(f, testo); return f; };
const ambitoValido = { context: { stage: 'C:/Temp/orbit-smart-inbox-ts3-' + 'a'.repeat(32), vault: 'data/v', technical: 'technical/v' }, autorizzati: ['liste'], creaIn: ['liste'] };

test('disattivato di default e senza ricerca automatica del vault', () => {
  const { settings, problemi } = carica({});
  assert.strictEqual(settings.smartInbox, null);
  assert.ok(!problemi.some(p => p.code === 'SMART_INBOX_AMBITO'));
});

test('lo scope arriva solo dal file indicato da ORBIT_SMART_INBOX_AMBITO', () => {
  const { settings } = carica({ ORBIT_SMART_INBOX_AMBITO: scrivi(JSON.stringify(ambitoValido)) });
  assert.deepStrictEqual(settings.smartInbox, ambitoValido);
});

test('file illeggibile o JSON non valido: problema segnalato e integrazione spenta', () => {
  for (const f of [scrivi('{non json'), path.join(os.tmpdir(), 'non-esiste-si.json')]) {
    const { settings, problemi } = carica({ ORBIT_SMART_INBOX_AMBITO: f });
    assert.strictEqual(settings.smartInbox, null);
    assert.ok(problemi.some(p => p.code === 'SMART_INBOX_AMBITO'));
  }
});

test('scope non sintetico (percorso personale): Orbit parte e l integrazione resta spenta', async () => {
  const problemi = [];
  const settings = settingsProva({ settings: { smartInbox: { context: { stage: 'C:/Users/x/Vault', vault: 'v', technical: 't' }, autorizzati: ['a'], creaIn: ['a'] } } });
  const app = creaApp({ settings, problemi, provider: new MockProvider(), storage: new Storage(':memory:'), attendiFn: () => Promise.resolve() });
  assert.ok(problemi.some(p => p.code === 'SMART_INBOX_AMBITO'));
  assert.strictEqual((await app.integrazioni.integrazioni.get('smartinbox').prerequisiti()).ok, false);
});
