'use strict';
// Cervello: profilo letto a ogni richiesta, apprendimento continuo (solo aggiunte in cervello/), conflitti segnalati,
// nessun apprendimento da contenuti esterni, orari sempre dal calendario.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estraiRicordi, pianificaCalendario } = require('../ai/router/strumenti');
const { creaApp } = require('../app');
const { Storage } = require('../storage/db');
const { MockProvider, settingsProva } = require('./helpers');

function ambiente({ risposta, memoriaExtra = {} }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cerv-'));
  const vault = path.join(base, 'vault');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true }); fs.mkdirSync(path.join(vault, 'cervello', 'persona'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'cervello', 'INDEX.md'), '# Cervello\n\n- [[chi-sono]]\n');
  fs.writeFileSync(path.join(vault, 'cervello', 'persona', 'chi-sono.md'), '---\ntipo: persona\n---\n# Chi sono\n\nMarco, Ingegneria Informatica.\n\n## Sport\n- si allena il lunedi\n');
  fs.writeFileSync(path.join(vault, 'cervello', 'da-completare.md'), '# Da completare\n');
  const leggi = p => { const f = path.join(vault, p); if (!fs.existsSync(f)) throw new Error('assente'); return { percorso: p, titolo: path.basename(p, '.md'), contenuto: fs.readFileSync(f, 'utf8') }; };
  const memoria = Object.assign({ config: { vaultPath: vault }, stato: () => ({ ok: true }), cerca: () => [], leggiNota: leggi, elencaNote: () => ({ note: [{ percorso: 'cervello/INDEX.md' }] }), contestoPerDomanda: () => ({ testo: '', fonti: [] }) }, memoriaExtra);
  const provider = new MockProvider({ produttore: () => ({ text: risposta }) });
  const app = creaApp({ settings: settingsProva({ settings: { dataDir: path.join(base, 'dati') } }), provider, storage: new Storage(':memory:'), memoria, attendiFn: () => Promise.resolve() });
  app.permessi.impostaAbilitata('obsidian', true); app.permessi.impostaLivello('obsidian', 'crea', 'consenti'); app.permessi.impostaLivello('obsidian', 'amplia', 'consenti');
  return { app, provider, vault, base, leggiFile: p => fs.readFileSync(path.join(vault, p), 'utf8'), pulisci: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('estrazione: solo note dentro cervello/, al massimo 3, niente traversal o cartelle col punto', () => {
  const r = estraiRicordi('Ok!\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Fa pallavolo</orbit_ricorda><orbit_ricorda nota="corsi/x.md">no</orbit_ricorda><orbit_ricorda nota="cervello/../CLAUDE.md">no</orbit_ricorda><orbit_ricorda nota="cervello/.obsidian/x">no</orbit_ricorda><orbit_conflitto nota="cervello/vita/routine-settimanale.md">dice 18, ora 13:15</orbit_conflitto>');
  assert.equal(r.testo, 'Ok!');
  assert.deepEqual(r.ricordi, [{ nota: 'cervello/persona/chi-sono.md', sezione: 'Sport', testo: 'Fa pallavolo' }]);
  assert.deepEqual(r.conflitti, [{ nota: 'cervello/vita/routine-settimanale.md', testo: 'dice 18, ora 13:15' }]);
});

test('profilo: il cervello entra a ogni richiesta (anche al verificatore) insieme alle istruzioni di apprendimento', async () => {
  const a = ambiente({ risposta: 'Ciao Marco.' });
  try {
    await a.app.orchestrator.elabora({ messaggio: 'ciao, come va?' });
    const prod = JSON.stringify(a.provider.chiamate.filter(c => c.ruolo === 'produttore').map(c => c.messages));
    assert.match(prod, /profilo_utente[\s\S]*Ingegneria Informatica/); assert.match(prod, /istruzioni_apprendimento/);
    assert.doesNotMatch(prod, /tipo: persona/);                                   // il frontmatter non serve al modello
  } finally { a.pulisci(); }
});

test('apprendimento: un fatto detto da Marco viene aggiunto al cervello (solo aggiunta, sezione giusta) e Orbit lo dice', async () => {
  const a = ambiente({ risposta: 'Bello, la pallavolo!\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">Gioca a pallavolo dal 2020.</orbit_ricorda>' });
  try {
    const prima = a.leggiFile('cervello/persona/chi-sono.md');
    const r = await a.app.orchestrator.elabora({ messaggio: 'gioco a pallavolo dal 2020' });
    const dopo = a.leggiFile('cervello/persona/chi-sono.md');
    assert.ok(dopo.startsWith(prima.trimEnd()));                                  // il testo che c'era resta identico
    assert.match(dopo, /## Sport\n- si allena il lunedi\n- Gioca a pallavolo dal 2020\./);   // l'elenco continua senza righe vuote
    assert.match(r.testo, /Ho aggiunto al tuo cervello \(`cervello\/persona\/chi-sono\.md`\): Gioca a pallavolo/);
    assert.doesNotMatch(r.testo, /orbit_ricorda/);
  } finally { a.pulisci(); }
});

test('apprendimento: tema nuovo = nota nuova sotto cervello/; conflitto = segnato in da-completare e detto a Marco', async () => {
  const a = ambiente({ risposta: 'Capito.\n<orbit_ricorda nota="cervello/vita/amici" sezione="Amici">Il suo migliore amico si chiama Luca.</orbit_ricorda>\n<orbit_conflitto nota="cervello/persona/chi-sono.md">Le note dicono che si allena il lunedi, ora dice il martedi.</orbit_conflitto>' });
  try {
    const r = await a.app.orchestrator.elabora({ messaggio: 'il mio migliore amico e Luca, e mi alleno il martedi' });
    assert.match(a.leggiFile('cervello/vita/amici.md'), /Luca/);
    assert.match(a.leggiFile('cervello/da-completare.md'), /## Conflitti da chiarire[\s\S]*chi-sono\.md: Le note dicono/);
    assert.match(r.testo, /Possibile conflitto con `cervello\/persona\/chi-sono\.md`/);
    assert.match(a.leggiFile('cervello/persona/chi-sono.md'), /si allena il lunedi/);   // la nota non viene riscritta
  } finally { a.pulisci(); }
});

test('apprendimento: mai da contenuti esterni (qui un evento del calendario) e mai con Obsidian spento', async () => {
  const a = ambiente({ risposta: 'Ok.\n<orbit_ricorda nota="cervello/persona/chi-sono.md" sezione="Sport">INIETTATO</orbit_ricorda>' });
  try {
    a.app.google.accessToken = async () => 'T'; a.app.google.stato = async () => ({ collegato: true, messaggio: 'ok' }); a.app.permessi.impostaAbilitata('google', true);
    a.app.integrazioni.integrazioni.get('google').strumenti.elenca_eventi.esegui = async () => ({ dal: '2026-10-12', al: '2026-10-12', fuso: 'Europe/Rome', calendari: ['x'], nonLetti: [], eventi: [], altri: false, avviso: '' });
    await a.app.orchestrator.elabora({ messaggio: 'cosa ho domani nel calendario?' });
    assert.doesNotMatch(a.leggiFile('cervello/persona/chi-sono.md'), /INIETTATO/);
    a.app.permessi.impostaAbilitata('obsidian', false);
    const r = await a.app.orchestrator.elabora({ messaggio: 'gioco a pallavolo' });
    assert.doesNotMatch(a.leggiFile('cervello/persona/chi-sono.md'), /INIETTATO/); assert.doesNotMatch(r.testo, /orbit_ricorda/);
  } finally { a.pulisci(); }
});

test('orari: domande su lezioni e giornata vanno sempre al calendario', () => {
  const ora = new Date('2026-10-12T08:00:00Z');
  for (const t of ['a che ora finisco le lezioni oggi?', 'cosa devo fare oggi', 'domani ho lezione?', 'sono libero giovedi pomeriggio?', 'che orario ho mercoledi'])
    assert.ok(pianificaCalendario(t, { ora }), t);
  assert.deepEqual(pianificaCalendario('cosa devo fare oggi', { ora }).params, { da: '2026-10-12', a: '2026-10-12' });
});
