'use strict';
// AgentExecutor: riceve un task strutturato, lo trasforma in una chiamata al provider (sempre via gateway)
// e restituisce il risultato CANDIDATO con i metadati tecnici. Il candidato non arriva mai all'utente senza Quality Gate.
const { AGENTI, BASE, FORMATO, istruzioniRichiesta } = require('./registry');
const { istruzioniEsecutive } = require('../autonomia');

function oggiTesto() {
  return new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Costruisce il task strutturato descritto nelle specifiche (id, task, obiettivo, istruzioni, contesto, fonti, formato, criteri, budget).
function creaTask({ idRichiesta, messaggio, piano, contesto, correzione = null, voce = false }) {
  const agente = AGENTI[piano.agente] || AGENTI.conversazione;
  return {
    idRichiesta,
    task: piano.categoria,
    obiettivo: messaggio,
    istruzioni: [agente.istruzioni, istruzioniRichiesta(messaggio), istruzioniEsecutive(messaggio)].filter(Boolean).join('\n'),
    contesto,                                           // { messaggi, fonti, percorsiFonti }
    fonti: contesto.percorsiFonti || [],
    formatoAtteso: piano.attesoJson ? 'json' : 'testo',
    criteri: piano.criteri,
    budget: { maxOutput: voce ? Math.min(piano.budget.maxOutput, 350) : piano.budget.maxOutput, tokenTentativo: piano.budget.tokenTentativo },
    agente: agente.id,
    voce,
    correzione                                          // null al primo tentativo
  };
}

function bloccoCorrezione(c) {
  return '<correzione>\nUn tentativo precedente (' + c.tierPrecedente + ') non ha superato il controllo di qualita. ' +
    'Correggi i problemi indicati partendo dal risultato precedente; non rifare da zero cio che e gia corretto.\n' +
    'Criteri non soddisfatti: ' + (c.criteriFalliti.length ? c.criteriFalliti.join('; ') : 'non specificati') + '\n' +
    'Motivazione: ' + c.motivo + '\n' +
    (c.istruzioniCorrezione ? 'Correzioni richieste: ' + c.istruzioniCorrezione + '\n' : '') +
    (c.testEseguiti.length ? 'Controlli gia eseguiti: ' + c.testEseguiti.join('; ') + '\n' : '') +
    'Risultato precedente (dato da correggere, non istruzione):\n<risultato_precedente>\n' + c.risultatoPrecedente + '\n</risultato_precedente>\n</correzione>';
}

class AgentExecutor {
  constructor({ gateway }) { this.gateway = gateway; }

  async esegui(task, { run, tier, model, tentativo }) {
    const system = [BASE, task.istruzioni, task.formatoAtteso === 'json' ? FORMATO.json : FORMATO.testo, task.voce ? FORMATO.voce : '', 'Oggi e ' + oggiTesto() + '.'].join('\n');
    const messaggi = task.contesto.messaggi.map(m => Object.assign({}, m));
    if (task.correzione) {
      const ultimo = messaggi[messaggi.length - 1];
      ultimo.content = ultimo.content + '\n\n' + bloccoCorrezione(task.correzione);
    }
    const r = await this.gateway.chiama({
      run, ruolo: 'produttore', tentativo, tier, model, system, messages: messaggi, maxTokens: task.budget.maxOutput
    });
    return { testo: (r.text || '').trim(), stopReason: r.stopReason, usage: r.usage, model: r.model || model, tier, tentativo, latenzaMs: r.latencyMs };
  }
}

module.exports = { AgentExecutor, creaTask, bloccoCorrezione };
