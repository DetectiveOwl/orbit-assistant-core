'use strict';
// ModelRouter: trasforma la classificazione in un piano strutturato. E deterministico e non chiama modelli:
// decidere quale modello usare non deve costare un'altra chiamata AI.
const { TIERS } = require('../../config');
const { tierAmmessi, tierPiuVicino } = require('./modelli-ammessi');
const { stimaToken } = require('../providers/gateway');

const AGENTE = {
  chitchat: 'conversazione', qa: 'conversazione', memory: 'memoria',
  math: 'ragionamento', analysis: 'ragionamento', planning: 'ragionamento', code: 'ragionamento',
  transform: 'testo', summary: 'testo', extraction: 'testo'
};

const CRITERI_BASE = ['Risponde alla richiesta originale senza deviare', 'Scritta in italiano, salvo diversa richiesta dell\'utente'];
const CRITERI_CATEGORIA = {
  memory: ['Basata solo sul contenuto delle note fornite', 'Cita i percorsi delle note usate', 'Distingue cio che e scritto nelle note da cio che e dedotto', 'Se le note non bastano lo dice, senza inventare'],
  math: ['Mostra i passaggi in ordine, senza salti logici', 'Il risultato finale e esplicito e coerente con i passaggi'],
  summary: ['Fedele al testo originale', 'Non aggiunge informazioni assenti nella fonte', 'Tiene i concetti necessari per una verifica'],
  transform: ['Conserva il significato originale', 'Restituisce il testo trasformato, senza commenti superflui'],
  extraction: ['Contiene solo informazioni presenti nella fonte', 'Nessun valore inventato o dedotto senza dirlo'],
  planning: ['Passi concreti e ordinati', 'Realistico rispetto ai dati e alle scadenze forniti'],
  analysis: ['Ragionamento coerente e senza contraddizioni', 'Le affermazioni fattuali sono supportate da fonti fornite o segnalate come non verificate'],
  code: ['Codice sintatticamente valido', 'Dichiara le assunzioni; il codice non viene eseguito da Orbit'],
  qa: ['Risposta corretta e sufficientemente completa', 'Se non sa, lo dice'],
  chitchat: ['Risposta breve e naturale']
};

function sceltaTier(c) {
  if (c.categoria === 'chitchat' && c.rischio !== 'high') return { tier: 'haiku', motivo: 'conversazione leggera' };
  if (c.complessita === 'high') {
    if (c.punti >= 5 || c.rischio === 'high') return { tier: 'opus', motivo: 'complessita elevata' + (c.rischio === 'high' ? ' e conseguenze di un errore alte' : '') };
    return { tier: 'sonnet', motivo: 'complessita alta: parto da Sonnet e salgo solo se serve' };
  }
  if (c.complessita === 'medium') return { tier: 'sonnet', motivo: 'ragionamento di media complessita' };
  if (c.rischio === 'high') return { tier: 'sonnet', motivo: 'compito semplice ma errore costoso' };
  return { tier: 'haiku', motivo: 'compito semplice a basso rischio' };
}

// Piano di verifica: cosa controlla il Quality Gate e con quale modello.
function pianoVerifica(c, tierProduttore, disponibili, limitiVerifica) {
  const controlli = ['non_vuota', 'non_troncata', 'lingua'];
  if (c.richiamaVault) controlli.push('fonti_citate');
  if (c.espressione) controlli.push('calcolo');
  if (c.attesoJson) controlli.push('json');
  if (c.categoria === 'code') controlli.push('sintassi_codice');
  const soloLocale = c.rischio !== 'high' && (c.categoria === 'chitchat' || !!c.espressione);
  // Con l'abbonamento ogni chiamata consuma limiti: in modalita "auto" il verificatore AI parte solo dove serve davvero
  // (complessita alta, rischio non basso, risposte basate sulle note). Negli altri casi bastano i controlli locali.
  const servePerDavvero = c.complessita === 'high' || c.rischio !== 'low' || c.richiamaVault;
  if (!soloLocale && limitiVerifica === 'auto' && !servePerDavvero) {
    return { modo: 'deterministico', controlli, tierVerificatore: null, motivo: 'compito semplice a basso rischio: controlli locali, nessuna chiamata AI in piu (ORBIT_AI_VERIFY=sempre per verificare sempre)' };
  }
  if (soloLocale) return { modo: 'deterministico', controlli, tierVerificatore: null, motivo: c.espressione ? 'il risultato si ricalcola in locale' : 'conversazione leggera: bastano i controlli locali' };
  let t = tierProduttore === 'opus' ? 'sonnet' : tierProduttore === 'sonnet' ? (c.complessita === 'high' || c.rischio === 'high' ? 'sonnet' : 'haiku') : 'haiku';
  t = tierPiuVicino(t, disponibili);
  return { modo: 'semantico', controlli, tierVerificatore: t, motivo: 'verifica con criteri espliciti, separata dalla chiamata che ha prodotto la risposta' };
}

// ctx: { disponibili: [tier], limiti, tokenContestoStimati }
function pianifica(c, { disponibili, limiti, tokenContestoStimati = 0, storiaMessaggi = 0, noteDaCercare = false, provider = 'claude-code', voce = false }) {
  // Un rischio alto riconosciuto non puo ripiegare sul modello leggero, neanche per disponibilita.
  disponibili = tierAmmessi(c, disponibili);
  if (!disponibili.length) return { stato: 'rifiutato', codice: 'NO_MODEL', motivo: 'Nessun modello configurato e disponibile.' };

  let { tier, motivo } = sceltaTier(c);
  if (c.tierEsplicito && (c.rischio !== 'high' || TIERS.indexOf(c.tierEsplicito) >= TIERS.indexOf(tier))) { tier = c.tierEsplicito; motivo = 'modello richiesto esplicitamente dall\'utente'; }
  const voluto = tier;
  tier = tierPiuVicino(tier, disponibili);
  if (tier !== voluto) motivo += ' (' + voluto + ' non disponibile, uso ' + tier + ')';

  // Budget: se la prima chiamata non ci sta, si scende di livello finche costa meno del tetto, altrimenti si rifiuta.
  const minOut = 256;
  const tettoTentativo = Math.min(limiti.budgetTokenTentativo, limiti.budgetTokenRichiesta);
  if (tokenContestoStimati + minOut > tettoTentativo) {
    return { stato: 'rifiutato', codice: 'BUDGET', motivo: 'Il contesto necessario (circa ' + tokenContestoStimati + ' token) supera il budget per tentativo (' + tettoTentativo + ').' };
  }
  const i = TIERS.indexOf(tier);
  const sopra = TIERS.slice(i + 1).filter(t => disponibili.includes(t)).slice(0, limiti.maxEscalation);
  let criteri = CRITERI_BASE.concat(CRITERI_CATEGORIA[c.categoria] || [], c.attesoJson ? ['Output JSON valido'] : []);
  if (voce) {   // risposta da leggere ad alta voce: i percorsi non si leggono e il testo deve essere breve e parlato
    criteri = criteri.map(x => (/Cita i percorsi/.test(x) ? 'Dice a voce da quali note viene, senza leggere i percorsi dei file' : x)).concat(['Adatta alla lettura ad alta voce: frasi brevi e naturali, senza elenchi o simboli']);
  }
  return {
    stato: 'ok',
    categoria: c.categoria, complessita: c.complessita, rischio: c.rischio,
    obiettivo: c.categoria + ' (' + c.complessita + ', rischio ' + c.rischio + ')',
    provider, tierIniziale: tier, motivo,
    agente: c.richiamaVault && !['planning', 'code', 'chitchat'].includes(c.categoria) ? 'memoria' : (AGENTE[c.categoria] || 'conversazione'),
    contesto: { storiaMessaggi, memoria: !!c.richiamaVault, memoriaCercata: noteDaCercare, tokenStimati: tokenContestoStimati },
    strumenti: c.richiamaVault ? ['memoria_vault (sola lettura)'] : [],
    criteri,
    verifica: pianoVerifica(c, tier, disponibili, limiti.verificaAI),
    budget: { tokenRichiesta: limiti.budgetTokenRichiesta, tokenTentativo: tettoTentativo, maxOutput: limiti.maxOutputTokens },
    escalation: {
      livelli: sopra, max: limiti.maxEscalation, maxTentativi: limiti.maxTentativi,
      condizioni: ['Quality Gate FAIL', 'Risposta troncata o vuota', 'Modello non disponibile']
    },
    espressione: c.espressione || null,
    attesoJson: !!c.attesoJson,
    segnali: c.segnali
  };
}

module.exports = { pianifica, tierPiuVicino, AGENTE, stimaToken };
