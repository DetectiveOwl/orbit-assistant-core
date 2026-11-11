'use strict';
// Perimetro di Smart Inbox (TS-6B): configurazione host, percorsi effettivi, marker, aree operative. Solo stage sintetici in cartelle temporanee.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validaAmbito, verificaPerimetroFs, scriviMarker, MARKER } = require('../../smart-inbox/perimetro');
const { creaIntegrazioneSmartInbox } = require('../integrations/smartinbox');
const { PIN_ENV, MANIFEST, normalizza } = require('../../smart-inbox/integrita');
const { sha } = require('../../smart-inbox/policy');

const creati = [];
test.after(() => { for (const p of creati) fs.rmSync(p, { recursive: true, force: true }); });
const nuovo = (marker = true) => {
  const stage = path.join(fs.realpathSync(os.tmpdir()), 'orbit-smart-inbox-ts3-' + crypto.randomBytes(16).toString('hex'));
  creati.push(stage);
  for (const d of ['home', 'tmp', 'data/v/to sort', 'data/v/liste', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  if (marker) scriviMarker(stage);
  return { stage, ambito: { context: { stage, vault: 'data/v', technical: 'technical/v' }, autorizzati: ['liste'], creaIn: ['liste'] } };
};
const rifiuta = (fn, code) => assert.throws(fn, { code });
const con = (a, patch) => ({ ...a, ...patch });

test('configurazione valida accettata e congelata; chiavi sconosciute o incomplete rifiutate', () => {
  const { ambito } = nuovo();
  assert.ok(Object.isFrozen(validaAmbito(ambito)));
  rifiuta(() => validaAmbito(con(ambito, { extra: 1 })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  for (const k of ['context', 'autorizzati', 'creaIn']) { const a = { ...ambito }; delete a[k]; rifiuta(() => validaAmbito(a), 'AMBITO_SMART_INBOX_NON_VALIDO'); }
  rifiuta(() => validaAmbito(con(ambito, { autorizzati: [] })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  for (const k of ['stage', 'vault', 'technical']) { const c = { ...ambito.context }; delete c[k]; rifiuta(() => validaAmbito(con(ambito, { context: c })), 'AMBITO_SMART_INBOX_NON_VALIDO'); }
  rifiuta(() => validaAmbito(null), 'AMBITO_SMART_INBOX_NON_VALIDO');
});

test('stage: solo percorso assoluto normalizzato con nome sintetico, mai radice, relativo o con ..', () => {
  const { ambito, stage } = nuovo();
  for (const s of ['C:\\', 'C:\\Users\\x\\Vault', stage + '\\..\\altro', stage.replace(/\\/g, '/'), 'orbit-smart-inbox-ts3-' + 'a'.repeat(32), '\\\\server\\share\\' + path.basename(stage)]) {
    rifiuta(() => validaAmbito(con(ambito, { context: { ...ambito.context, stage: s } })), 'STAGING_SINTETICO_RICHIESTO');
  }
});

test('vault e area tecnica: separati, non annidati, non nelle cartelle del bridge', () => {
  const { ambito } = nuovo();
  const ctx = patch => con(ambito, { context: { ...ambito.context, ...patch } });
  rifiuta(() => validaAmbito(ctx({ technical: 'data/v/tech' })), 'AREA_TECNICA_DENTRO_VAULT');
  rifiuta(() => validaAmbito(ctx({ vault: 'technical/v/vault' })), 'AREA_TECNICA_DENTRO_VAULT');
  rifiuta(() => validaAmbito(ctx({ technical: 'data/v' })), 'AREA_TECNICA_DENTRO_VAULT');
  rifiuta(() => validaAmbito(ctx({ vault: 'home/v' })), 'PERCORSO_NON_SICURO');
  rifiuta(() => validaAmbito(ctx({ technical: 'TMP/t' })), 'PERCORSO_NON_SICURO');
  rifiuta(() => validaAmbito(ctx({ vault: '../fuori' })), 'PERCORSO_NON_SICURO');
});

test('cartelle autorizzate: niente aree tecniche, niente to sort, creaIn solo dentro le autorizzate', () => {
  const { ambito } = nuovo();
  for (const a of [['scadenze'], ['liste/.privato'], ['to sort'], ['to sort/x'], ['Progetti/Orbit']]) assert.throws(() => validaAmbito(con(ambito, { autorizzati: a })), { code: /^(AMBITO_SMART_INBOX_NON_VALIDO|PERCORSO_NON_SICURO)$/ });
  rifiuta(() => validaAmbito(con(ambito, { autorizzati: ['../x'] })), 'PERCORSO_NON_SICURO');
  rifiuta(() => validaAmbito(con(ambito, { creaIn: ['altre'] })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  rifiuta(() => validaAmbito(con(ambito, { creazioni: [] })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  assert.ok(validaAmbito(con(ambito, { creaIn: ['liste/nuova'], creazioni: { 'to sort/a.md': 'liste/nuova' } })));
});

test('uno stage che contiene o sta dentro un area operativa di Orbit e rifiutato (repository, vault personale, dati)', () => {
  const { ambito, stage } = nuovo();
  const repo = path.resolve(__dirname, '..', '..');
  assert.ok(validaAmbito(ambito, { aree: [repo] }));
  for (const area of [stage, path.dirname(stage), path.join(stage, 'data'), path.join(stage, 'data/v').toUpperCase()]) {
    rifiuta(() => validaAmbito(ambito, { aree: [area] }), 'PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT');
  }
  assert.ok(validaAmbito(ambito, { aree: ['D:\\Dati\\Orbit', 'C:\\Users\\altro\\Vault'] }));
});

test('verifica su disco: stage valido con marker accettato', () => {
  const { ambito } = nuovo();
  assert.strictEqual(verificaPerimetroFs(ambito.context), true);
});

test('senza marker, con marker alterato o di un altro stage il bridge non parte', () => {
  const senza = nuovo(false);
  rifiuta(() => verificaPerimetroFs(senza.ambito.context), 'PERIMETRO_NON_VERIFICABILE');
  const altro = nuovo(false), { stage, ambito } = nuovo(false);
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ versione: 1, tipo: 'sintetico', stage: altro.stage }));
  rifiuta(() => verificaPerimetroFs(ambito.context), 'MARKER_PERIMETRO_NON_VALIDO');
  for (const dati of ['{non json', '{}', JSON.stringify({ versione: 2, tipo: 'sintetico', stage }), JSON.stringify({ versione: 1, tipo: 'sintetico', stage, extra: 1 }), 'x'.repeat(4000)]) {
    fs.writeFileSync(path.join(stage, MARKER), dati);
    rifiuta(() => verificaPerimetroFs(ambito.context), 'MARKER_PERIMETRO_NON_VALIDO');
  }
});

test('un ambiente non sintetico non si abilita da configurazione: nemmeno con marker coerente', () => {
  const { stage, ambito } = nuovo(false);
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ versione: 1, tipo: 'personale', stage }));
  rifiuta(() => verificaPerimetroFs(ambito.context), 'AMBIENTE_NON_SINTETICO_NON_ABILITATO');
});

test('stage, vault o area tecnica mancanti o non cartelle', () => {
  const a = nuovo(); fs.rmSync(path.join(a.stage, 'technical'), { recursive: true });
  rifiuta(() => verificaPerimetroFs(a.ambito.context), 'PERIMETRO_NON_VERIFICABILE');
  const b = nuovo(); fs.rmSync(path.join(b.stage, 'data/v'), { recursive: true }); fs.writeFileSync(path.join(b.stage, 'data/v'), 'x');
  rifiuta(() => verificaPerimetroFs(b.ambito.context), 'PERIMETRO_NON_REALE');
  rifiuta(() => verificaPerimetroFs({ ...a.ambito.context, stage: path.join(a.stage, 'inesistente') }), 'PERIMETRO_NON_VERIFICABILE');
});

test('junction/collegamento: lo stage o le sue cartelle che puntano altrove sono rifiutati', { skip: process.platform !== 'win32' && 'collegamenti NTFS' }, () => {
  const fuori = nuovo(), base = nuovo();
  fs.rmSync(path.join(base.stage, 'data/v'), { recursive: true });
  fs.symlinkSync(path.join(fuori.stage, 'data/v'), path.join(base.stage, 'data/v'), 'junction');
  rifiuta(() => verificaPerimetroFs(base.ambito.context), 'PERIMETRO_NON_REALE');
  const link = path.join(fs.realpathSync(os.tmpdir()), 'orbit-smart-inbox-ts3-' + crypto.randomBytes(16).toString('hex'));
  creati.push(link);
  fs.symlinkSync(fuori.stage, link, 'junction');
  rifiuta(() => verificaPerimetroFs({ ...fuori.ambito.context, stage: link }), 'PERIMETRO_NON_REALE');
});

test('verifica su disco: stage che contiene il repository o un area dichiarata dall host', () => {
  const { ambito, stage } = nuovo();
  rifiuta(() => verificaPerimetroFs(ambito.context, { aree: [path.join(stage, 'data')] }), 'PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT');
});

test('scriviMarker: solo su stage sintetico esistente e mai sovrascrivendo', () => {
  const { stage } = nuovo(false);
  scriviMarker(stage);
  assert.throws(() => scriviMarker(stage), { code: 'EEXIST' });
  rifiuta(() => scriviMarker(path.join(fs.realpathSync(os.tmpdir()), 'qualunque')), 'STAGING_SINTETICO_RICHIESTO');
});

test('integrazione: scope non valido = errore (Orbit lo spegne); prerequisiti riflettono il disco', async () => {
  const { ambito, stage } = nuovo();
  rifiuta(() => creaIntegrazioneSmartInbox({ ambito: con(ambito, { autorizzati: [] }) }), 'AMBITO_SMART_INBOX_NON_VALIDO');
  rifiuta(() => creaIntegrazioneSmartInbox({ ambito, aree: [path.dirname(stage)] }), 'PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT');
  const integr = creaIntegrazioneSmartInbox({ ambito });
  const salvato = process.env[PIN_ENV];
  try {
    delete process.env[PIN_ENV];
    const senzaPin = await integr.prerequisiti();
    assert.strictEqual(senzaPin.ok, false);
    assert.match(senzaPin.messaggio, /MANIFEST_BRIDGE_PIN_MANCANTE/);
    process.env[PIN_ENV] = '0'.repeat(64);
    assert.match((await integr.prerequisiti()).messaggio, /MANIFEST_BRIDGE_PIN_DIVERSO/);
    process.env[PIN_ENV] = sha(normalizza(fs.readFileSync(path.join(__dirname, '..', '..', 'smart-inbox', 'windows', MANIFEST))));
    assert.strictEqual((await integr.prerequisiti()).ok, true);
  } finally { if (salvato === undefined) delete process.env[PIN_ENV]; else process.env[PIN_ENV] = salvato; }
  fs.rmSync(path.join(stage, MARKER));
  const r = await integr.prerequisiti();
  assert.strictEqual(r.ok, false);
  assert.match(r.messaggio, /PERIMETRO_NON_VERIFICABILE/);
  assert.strictEqual((await creaIntegrazioneSmartInbox().prerequisiti()).ok, false);   // spenta di default
});

test('il percorso reale del vault non compare nel codice di Smart Inbox', () => {
  for (const f of ['perimetro.js', 'integrita.js', 'cli-windows.js', 'cli.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', '..', 'smart-inbox', f), 'utf8'), /Obsidian|Documents[\\/]+Orbit|Users[\\/]+ricca/i, f);
  }
});

// Tipo "reale": stage fuori dal vault, vault assoluto fissato anche dal marker dell'host. Cartelle temporanee, nessun vault personale.
const nuovoReale = (marker = true) => {
  const base = fs.realpathSync(os.tmpdir()), vault = path.join(base, 'vault-' + crypto.randomBytes(6).toString('hex'));
  const stage = path.join(base, 'orbit-smart-inbox-real-' + crypto.randomBytes(16).toString('hex'));
  creati.push(stage, vault);
  for (const d of ['home', 'tmp', 'technical/v']) fs.mkdirSync(path.join(stage, d), { recursive: true });
  for (const d of ['to sort', 'liste', 'cervello']) fs.mkdirSync(path.join(vault, d), { recursive: true });
  if (marker) scriviMarker(stage, vault);
  return { stage, vault, ambito: { context: { stage, vault, technical: 'technical/v' }, autorizzati: ['liste'], creaIn: ['liste'] } };
};

test('vault reale: configurazione e disco accettati solo con stage reale, marker col vault e vault fuori dallo stage', () => {
  const { ambito, stage, vault } = nuovoReale();
  assert.ok(validaAmbito(ambito, { aree: [vault] }));
  assert.strictEqual(verificaPerimetroFs(ambito.context, { aree: [vault] }), true);
  const ctx = patch => con(ambito, { context: { ...ambito.context, ...patch } });
  rifiuta(() => validaAmbito(ctx({ vault: 'data/v' })), 'VAULT_REALE_NON_VALIDO');
  rifiuta(() => validaAmbito(ctx({ vault: stage })), 'AREA_TECNICA_DENTRO_VAULT');
  rifiuta(() => validaAmbito(ctx({ vault: path.join(stage, 'x') })), 'AREA_TECNICA_DENTRO_VAULT');
  rifiuta(() => validaAmbito(ctx({ vault: path.dirname(stage) })), 'AREA_TECNICA_DENTRO_VAULT');
  rifiuta(() => validaAmbito(ctx({ vault: path.parse(vault).root })), 'VAULT_REALE_NON_VALIDO');
  rifiuta(() => validaAmbito(ctx({ vault: vault + '/../altro' })), 'VAULT_REALE_NON_VALIDO');
  rifiuta(() => validaAmbito(con(ambito, { autorizzati: ['scadenze'] })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  rifiuta(() => validaAmbito(con(ambito, { autorizzati: ['to sort'] })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  rifiuta(() => validaAmbito(ambito, { aree: [stage] }), 'PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT');
  // il vault nel contesto deve coincidere con quello del marker (scritto dall'host)
  const altro = nuovoReale(false);
  rifiuta(() => verificaPerimetroFs({ ...ambito.context, vault: altro.vault }), 'MARKER_PERIMETRO_NON_VALIDO');
});

test('vault reale: marker senza vault, tipo sbagliato o vault dentro lo stage = rifiuto; scriviMarker coerente col nome', () => {
  const a = nuovoReale(false);
  for (const dati of [{ versione: 1, tipo: 'reale', stage: a.stage }, { versione: 1, tipo: 'sintetico', stage: a.stage, vault: a.vault }]) {
    fs.writeFileSync(path.join(a.stage, MARKER), JSON.stringify(dati));
    rifiuta(() => verificaPerimetroFs(a.ambito.context), 'MARKER_PERIMETRO_NON_VALIDO');
    fs.rmSync(path.join(a.stage, MARKER));
  }
  rifiuta(() => scriviMarker(a.stage), 'VAULT_REALE_NON_VALIDO');
  rifiuta(() => scriviMarker(a.stage, 'relativo'), 'VAULT_REALE_NON_VALIDO');
  const s = nuovo(false);
  rifiuta(() => scriviMarker(s.stage, a.vault), 'VAULT_REALE_NON_VALIDO');
  // il tipo del marker deve corrispondere al nome: stage sintetico con marker "reale" rifiutato
  fs.writeFileSync(path.join(s.stage, MARKER), JSON.stringify({ versione: 1, tipo: 'reale', stage: s.stage }));
  rifiuta(() => verificaPerimetroFs(s.ambito.context), 'MARKER_PERIMETRO_NON_VALIDO');
  scriviMarker(a.stage, a.vault);
  fs.rmSync(a.vault, { recursive: true });
  rifiuta(() => verificaPerimetroFs(a.ambito.context), 'PERIMETRO_NON_VERIFICABILE');
});

test('autoApplica: solo booleano deciso dall host; livello dello strumento applica e istruzioni seguono la configurazione', () => {
  const { ambito } = nuovo();
  assert.ok(validaAmbito(con(ambito, { autoApplica: true })));
  for (const v of ['true', 1, null, {}]) rifiuta(() => validaAmbito(con(ambito, { autoApplica: v })), 'AMBITO_SMART_INBOX_NON_VALIDO');
  const livello = a => creaIntegrazioneSmartInbox({ ambito: a }).strumenti.applica.livello;
  assert.strictEqual(livello(ambito), 'modifica');
  assert.strictEqual(livello(con(ambito, { autoApplica: false })), 'modifica');
  assert.strictEqual(livello(con(ambito, { autoApplica: true })), 'lettura');
  assert.strictEqual(creaIntegrazioneSmartInbox({ ambito }).autoApplica, false);
  const { ISTRUZIONI, ISTRUZIONI_AUTO } = require('../integrations/smartinbox');
  assert.match(ISTRUZIONI, /Dopo un piano chiaro fermati/);
  assert.doesNotMatch(ISTRUZIONI_AUTO, /Dopo un piano chiaro fermati/);
  assert.match(ISTRUZIONI_AUTO, /CONFIRM o BLOCK fermati/);
});

test('creaDefault: solo una cartella di creaIn; l\'integrazione non passa autoApplica alla CLI (chiavi rigide)', async () => {
  const { ambito } = nuovo();
  assert.ok(validaAmbito(con(ambito, { creaDefault: 'liste' })));
  for (const v of ['altre', 5, '../x', '']) assert.throws(() => validaAmbito(con(ambito, { creaDefault: v })), { code: /^(AMBITO_SMART_INBOX_NON_VALIDO|PERCORSO_NON_SICURO)$/ });
  const visto = [];
  const integr = creaIntegrazioneSmartInbox({ ambito: con(ambito, { autoApplica: true, creaDefault: 'liste' }), esegui: async (c, i) => { visto.push(i); throw Object.assign(new Error('x'), { code: 'FINTO' }); } });
  await assert.rejects(integr.strumenti.prepara.esegui({}, { conversazione: 'c1' }), { code: 'FINTO' });
  assert.ok(!('autoApplica' in visto[0]) && visto[0].creaDefault === 'liste');
});
