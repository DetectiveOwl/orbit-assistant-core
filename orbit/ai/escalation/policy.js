'use strict';
// EscalationPolicy: decide cosa fare dopo un esito del Quality Gate o un errore. Funzioni pure, testabili senza rete.
// Flusso predefinito: Haiku -> Sonnet -> Opus. Dopo il livello piu alto, al massimo un tentativo mirato aggiuntivo.
// Nessun ciclo: ogni ramo consuma tentativi, escalation o budget, e il numero di tentativi ha un tetto.

const { TIERS, tierAmmessi } = require('../router/modelli-ammessi');

const AZIONI = {
  ACCETTA: 'accetta',
  ESCALA: 'escala',
  MIRATO: 'tentativo_mirato',
  CHIARIMENTI: 'chiedi_chiarimenti',
  LIMITI: 'consegna_con_limiti',
  RIVERIFICA: 'riprova_verifica'
};

class EscalationPolicy {
  constructor({ limiti, margineToken = 600 }) {
    this.limiti = limiti;
    this.margineToken = margineToken;   // sotto questo residuo non conviene tentare un'altra chiamata
  }

  statoIniziale(piano) {
    return { tierCorrente: piano.tierIniziale, tentativi: 0, escalation: 0, mirato: 0, riverifiche: 0, storico: [] };
  }

  // esito: risultato del gate. residuo: token ancora spendibili nella richiesta.
  dopoVerifica({ esito, piano, stato, residuoToken }) {
    if (esito.status === 'PASS') return { azione: AZIONI.ACCETTA };
    if (esito.status === 'NEEDS_CLARIFICATION') return { azione: AZIONI.CHIARIMENTI, motivo: esito.reason };
    if (esito.status === 'ERROR') {
      // Errore infrastrutturale del verificatore: una sola riverifica, poi si consegna dichiarando che non e verificata.
      if (stato.riverifiche < 1 && residuoToken > this.margineToken) return { azione: AZIONI.RIVERIFICA };
      return { azione: AZIONI.LIMITI, motivo: 'verifica_non_completata', dettaglio: esito.reason };
    }
    // FAIL
    if (stato.tentativi >= this.limiti.maxTentativi) return { azione: AZIONI.LIMITI, motivo: 'max_tentativi', dettaglio: 'Raggiunto il numero massimo di tentativi (' + this.limiti.maxTentativi + ').' };
    if (residuoToken <= this.margineToken) return { azione: AZIONI.LIMITI, motivo: 'budget_esaurito', dettaglio: 'Budget di token esaurito.' };
    const livelli = tierAmmessi(piano, piano.escalation.livelli);
    const prossimo = livelli.slice(stato.escalation).find(t => TIERS.indexOf(t) > TIERS.indexOf(stato.tierCorrente));
    if (prossimo && stato.escalation < this.limiti.maxEscalation) {
      return { azione: AZIONI.ESCALA, tier: prossimo, motivo: esito.reason, criteriFalliti: esito.failed_criteria };
    }
    if (stato.mirato < 1) return { azione: AZIONI.MIRATO, tier: stato.tierCorrente, motivo: esito.reason, criteriFalliti: esito.failed_criteria };
    return { azione: AZIONI.LIMITI, motivo: 'verifica_fallita', dettaglio: esito.reason };
  }

  // Errore della chiamata al produttore (dopo i retry del gateway).
  dopoErrore({ errore, piano, stato, residuoToken, tierDisponibili }) {
    if (errore.code === 'ABORTED') return { azione: 'interrompi' };
    if (errore.fatal) return { azione: 'errore', errore };
    if (stato.tentativi >= this.limiti.maxTentativi || residuoToken <= this.margineToken) return { azione: 'errore', errore };
    if (errore.code === 'MODEL_NOT_FOUND') {
      const alt = tierAmmessi(piano, tierDisponibili).find(t => t !== stato.tierCorrente);
      return alt ? { azione: 'cambia_modello', tier: alt, motivo: 'modello non disponibile' } : { azione: 'errore', errore };
    }
    // Errori transitori persistenti: prova un livello diverso una sola volta.
    const prossimo = tierAmmessi(piano, piano.escalation.livelli).find(t => tierDisponibili.includes(t) && TIERS.indexOf(t) > TIERS.indexOf(stato.tierCorrente));
    if (prossimo && stato.escalation < this.limiti.maxEscalation) return { azione: 'cambia_modello', tier: prossimo, motivo: 'errore del servizio (' + errore.code + ')' };
    return { azione: 'errore', errore };
  }
}

module.exports = { EscalationPolicy, AZIONI };
