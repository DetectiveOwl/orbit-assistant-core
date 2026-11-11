'use strict';
// Perimetro di Smart Inbox deciso dall'host. Il root arriva solo dalla configurazione dell'host (ORBIT_SMART_INBOX_AMBITO), mai dal modello,
// dalle note o dal vault. Livelli: (1) forma e percorsi della configurazione (validaAmbito, senza accesso al disco);
// (2) percorsi effettivi su disco (verificaPerimetroFs): nessun collegamento/junction, marker dell'host nello stage, sottocartelle reali,
// nessuna sovrapposizione con le aree operative di Orbit; (3) bridge nativo: stesso marker e nome stage (windows/cli-host.ps1, Handles.cs).
// Tipi abilitati nel codice (non da configurazione): 'sintetico' (stage orbit-smart-inbox-ts3-*, vault dentro lo stage) e 'reale' (stage orbit-smart-inbox-real-*
// fuori dal vault, che e un percorso ASSOLUTO dichiarato anche nel marker; nello stage restano solo technical/home/tmp).
const fs = require('node:fs'), path = require('node:path');
const { relativo, protetto, sotto, chiave, congela, errore } = require('./policy');

const win = path.win32;
const MARKER = '.orbit-smart-inbox-perimetro.json';
const TIPI_ABILITATI = ['sintetico', 'reale'];
const STAGE = /^orbit-smart-inbox-(?:ts3|real)-[0-9a-f]{32}$/;
const tipoStage = stage => (/^orbit-smart-inbox-real-/.test(win.basename(stage)) ? 'reale' : 'sintetico');
const assoluto = v => typeof v === 'string' && /^[a-z]:\\/i.test(v);
const OPERAZIONI_AUTO = ['create', 'append', 'create_dir'];
const RISERVATE = ['home', 'tmp'];   // cartelle del bridge dentro lo stage
const REPO = path.resolve(__dirname, '..');

// Solo gli errori di questo modulo (nego) escono col proprio codice; ogni altro errore del disco diventa PERIMETRO_NON_VERIFICABILE.
const nego = codice => Object.assign(errore(codice), { nostro: true });
const uguali = (a, b) => win.normalize(a).toLowerCase() === win.normalize(b).toLowerCase();
const dentro = (figlio, padre) => { const r = win.relative(padre, figlio).toLowerCase(); return r === '' || (!r.startsWith('..') && !win.isAbsolute(r)); };
const percorsi = (c) => ({ vault: win.resolve(c.stage, c.vault), technical: win.join(c.stage, c.technical) });
const aree = extra => [REPO, ...extra].filter(Boolean).map(a => win.resolve(String(a)));

function chiaviEsatte(valore, richieste, facoltative = [], codice = 'AMBITO_SMART_INBOX_NON_VALIDO') {
  if (!valore || typeof valore !== 'object' || Array.isArray(valore) || Object.getPrototypeOf(valore) !== Object.prototype
    || Object.keys(valore).some(k => ![...richieste, ...facoltative].includes(k)) || richieste.some(k => !(k in valore))) throw nego(codice);
}

// Livello 1: solo forma e percorsi. Rifiuta configurazioni incomplete, percorsi non normalizzati e stage che toccano aree operative.
function validaAmbito(ambito, { aree: extra = [] } = {}) {
  chiaviEsatte(ambito, ['context', 'autorizzati', 'creaIn'], ['creazioni', 'autoApplica', 'creaDefault', 'autoOperazioni', 'autoCartelle']);
  if ('autoApplica' in ambito && typeof ambito.autoApplica !== 'boolean') throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  // Autorizzazione persistente (agisce solo con autoApplica): tipi di operazione e cartelle in cui l'host salta la finestra. Assenti = create+append in tutte le autorizzate.
  if ('autoOperazioni' in ambito && (!Array.isArray(ambito.autoOperazioni) || !ambito.autoOperazioni.length || new Set(ambito.autoOperazioni).size !== ambito.autoOperazioni.length
    || ambito.autoOperazioni.some(o => !OPERAZIONI_AUTO.includes(o)))) throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  if ('autoCartelle' in ambito && (!Array.isArray(ambito.autoCartelle) || !ambito.autoCartelle.length || ambito.autoCartelle.length > 64 || !Array.isArray(ambito.autorizzati)
    || ambito.autoCartelle.some(p => relativo(p) !== p || protetto(p) || !ambito.autorizzati.some(a => sotto(p, a))))) throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  if ('creaDefault' in ambito && (typeof ambito.creaDefault !== 'string' || relativo(ambito.creaDefault) !== ambito.creaDefault || !(ambito.creaIn ?? []).includes(ambito.creaDefault))) throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  const c = ambito.context;
  chiaviEsatte(c, ['stage', 'vault', 'technical']);
  if (typeof c.stage !== 'string' || !/^[a-z]:\\/i.test(c.stage) || win.resolve(c.stage) !== c.stage
    || c.stage.length > 200 || !STAGE.test(win.basename(c.stage))) throw nego('STAGING_SINTETICO_RICHIESTO');
  if (relativo(c.technical) !== c.technical || RISERVATE.includes(chiave(c.technical).split('/')[0])) throw nego('PERCORSO_NON_SICURO');
  if (tipoStage(c.stage) === 'reale') {
    // Vault reale: percorso assoluto normalizzato, sullo stesso disco dello stage ma mai dentro o sopra lo stage.
    if (!assoluto(c.vault) || win.resolve(c.vault) !== c.vault || c.vault.length > 200 || win.parse(c.vault).root === c.vault
      || win.parse(c.vault).root.toLowerCase() !== win.parse(c.stage).root.toLowerCase()) throw nego('VAULT_REALE_NON_VALIDO');
    if (dentro(c.vault, c.stage) || dentro(c.stage, c.vault)) throw nego('AREA_TECNICA_DENTRO_VAULT');
  } else {
    if (relativo(c.vault) !== c.vault || RISERVATE.includes(chiave(c.vault).split('/')[0])) throw nego('PERCORSO_NON_SICURO');
    const vault = chiave(c.vault), tech = chiave(c.technical);
    if (sotto(vault, tech) || sotto(tech, vault)) throw nego('AREA_TECNICA_DENTRO_VAULT');
  }
  for (const area of aree(extra)) if (dentro(c.stage, area) || dentro(area, c.stage)) throw nego('PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT');
  for (const k of ['autorizzati', 'creaIn']) {
    if (!Array.isArray(ambito[k]) || (k === 'autorizzati' && !ambito[k].length) || ambito[k].length > 64 || ambito[k].some(p => relativo(p) !== p || protetto(p))) throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  }
  if (ambito.autorizzati.some(p => sotto(p, 'to sort') || sotto('to sort', p)) || ambito.creaIn.some(p => !ambito.autorizzati.some(a => sotto(p, a)))) throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  if ('creazioni' in ambito && (!ambito.creazioni || typeof ambito.creazioni !== 'object' || Array.isArray(ambito.creazioni)
    || Object.entries(ambito.creazioni).some(([k, v]) => typeof k !== 'string' || typeof v !== 'string'))) throw nego('AMBITO_SMART_INBOX_NON_VALIDO');
  return congela(JSON.parse(JSON.stringify(ambito)));
}

// Regole dell'autorizzazione persistente, lette dalla sola configurazione dell'host. null = autorizzazione spenta (si revoca con autoApplica:false o togliendo la chiave).
const regoleAuto = ambito => (ambito?.autoApplica === true ? { operazioni: [...(ambito.autoOperazioni || ['create', 'append'])], cartelle: [...(ambito.autoCartelle || ambito.autorizzati)] } : null);

const reale = p => win.normalize(fs.realpathSync.native(p));
// Livello 2: percorsi effettivi su disco. Va richiamato prima di ogni uso del bridge e per i prerequisiti.
function verificaPerimetroFs(context, { aree: extra = [] } = {}) {
  const { stage } = context;
  try {
    if (!fs.lstatSync(stage).isDirectory() || !uguali(reale(stage), stage)) throw nego('PERIMETRO_NON_REALE');
    for (const area of aree(extra)) {
      let r = area; try { r = reale(area); } catch { /* area non esistente: resta il confronto sul percorso dichiarato */ }
      if (dentro(stage, r) || dentro(r, stage)) throw nego('PERIMETRO_SOVRAPPOSTO_AD_AREA_ORBIT');
    }
    const marker = win.join(stage, MARKER), st = fs.lstatSync(marker);
    if (!st.isFile() || st.size > 2048) throw nego('MARKER_PERIMETRO_NON_VALIDO');
    let dati; try { dati = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { throw nego('MARKER_PERIMETRO_NON_VALIDO'); }
    const rea = tipoStage(stage) === 'reale';
    chiaviEsatte(dati, ['versione', 'tipo', 'stage'], rea ? ['vault'] : [], 'MARKER_PERIMETRO_NON_VALIDO');
    if (dati.versione !== 1 || typeof dati.stage !== 'string' || !uguali(dati.stage, stage)) throw nego('MARKER_PERIMETRO_NON_VALIDO');
    if (!TIPI_ABILITATI.includes(dati.tipo)) throw nego('AMBIENTE_NON_SINTETICO_NON_ABILITATO');
    // Il tipo del marker deve corrispondere al nome dello stage; per il vault reale il marker (scritto dall'host) fissa anche il vault.
    if (dati.tipo !== tipoStage(stage) || (rea && (typeof dati.vault !== 'string' || !uguali(dati.vault, context.vault)))) throw nego('MARKER_PERIMETRO_NON_VALIDO');
    const p = percorsi(context);
    if (!fs.lstatSync(p.technical).isDirectory() || !dentro(reale(p.technical), reale(stage)) || !uguali(reale(p.technical), p.technical)) throw nego('PERIMETRO_NON_REALE');
    if (!fs.lstatSync(p.vault).isDirectory() || !uguali(reale(p.vault), p.vault) || (rea ? dentro(reale(p.vault), reale(stage)) : !dentro(reale(p.vault), reale(stage)))) throw nego('PERIMETRO_NON_REALE');
  } catch (e) { throw e.nostro ? e : errore('PERIMETRO_NON_VERIFICABILE'); }
  return true;
}

// Procedura dell'host per dichiarare uno stage sintetico: scrive il marker (mai sovrascrive) e nient'altro.
function scriviMarker(stage, vault) {
  if (typeof stage !== 'string' || win.resolve(stage) !== stage || !STAGE.test(win.basename(stage)) || !fs.statSync(stage).isDirectory()) throw nego('STAGING_SINTETICO_RICHIESTO');
  const rea = tipoStage(stage) === 'reale';
  if (rea !== (vault !== undefined) || (rea && (!assoluto(vault) || win.resolve(vault) !== vault || !fs.statSync(vault).isDirectory()))) throw nego('VAULT_REALE_NON_VALIDO');
  fs.writeFileSync(win.join(stage, MARKER), JSON.stringify(rea ? { versione: 1, tipo: 'reale', stage, vault } : { versione: 1, tipo: 'sintetico', stage }), { flag: 'wx' });
}

module.exports = { MARKER, TIPI_ABILITATI, STAGE, regoleAuto, validaAmbito, verificaPerimetroFs, scriviMarker };
