'use strict';
(function (root) {
  function crea(win, { attivo = true, voce = null } = {}) {
    if (!attivo) return null;
    const inizio = voce?.parlatoFine ?? win.performance.now();
    const punti = {};
    const marca = (fase, ora = win.performance.now()) => { if (!(fase in punti)) punti[fase] = Math.max(0, ora - inizio); };
    if (voce) { if (voce.parlatoFine !== undefined) marca('parlato_fine', voce.parlatoFine); if (voce.trascrizioneFine !== undefined) marca('trascrizione_fine', voce.trascrizioneFine); }
    let richiesta = null;
    return { punti, marca, get richiesta() { return richiesta; }, collega: id => { richiesta = id; },
      invia() {
        if (!richiesta || !win.fetch) return;
        win.fetch('/api/performance/' + richiesta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orbit': '1' }, body: JSON.stringify({ punti }) }).catch(() => {});
      },
      dipinta(elemento, valida) {
        const tick = () => {
          if (!valida() || win.document.hidden) return;
          const r = elemento.getBoundingClientRect(), s = win.getComputedStyle(elemento);
          if (r.width > 0 && r.height > 0 && Number(s.opacity) > 0 && s.visibility !== 'hidden') {
            // Due frame: il primo prepara il DOM, il secondo segue un'opportunita di paint.
            win.requestAnimationFrame(() => { if (!valida() || win.document.hidden) return; marca('visibile'); marca('completa'); this.invia(); });
          } else win.requestAnimationFrame(tick);
        };
        win.requestAnimationFrame(tick);
      }
    };
  }
  const api = { crea };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OrbitPerformance = api;
})(typeof window !== 'undefined' ? window : globalThis);
