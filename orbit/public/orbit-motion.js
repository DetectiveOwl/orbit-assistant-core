'use strict';
// Sistema di movimento di Orbit: UNA sola simulazione condivisa da nucleo 3D, rete, contenitore della risposta e testo.
// Non disegna nulla (lo fa orbit-core.js) e non decide nulla sugli stati (arrivano da core-state.js, cioe da eventi reali).
//
// Perche niente "effetto slide": ogni grandezza visibile e una molla smorzata che insegue un obiettivo.
//  - cambiare stato cambia solo gli OBIETTIVI: posizioni, velocita e forme continuano da dove sono, senza reset;
//  - i nodi della rete sono creati una volta sola (seme fisso): uno stato ne attiva di piu o di meno, non li ricrea;
//  - il tempo del rumore si integra con la velocita corrente, quindi rallentare o accelerare non fa saltare la forma;
//  - apertura e rientro della rete partono insieme; la rete riemerge solo a contenitore chiuso.
(function (root) {
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const lisc = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  // Molla del secondo ordine (w: pulsazione, z: smorzamento; z=1 critico, niente rimbalzi). Integrazione semi-implicita a sotto-passi.
  function molla(x = 0, w = 6, z = 1) { return { x, v: 0, target: x, w, z }; }
  function passoMolla(m, dt) {
    const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
    for (let i = 0; i < n; i++) { const a = m.w * m.w * (m.target - m.x) - 2 * m.z * m.w * m.v; m.v += a * h; m.x += m.v * h; }
  }
  const fissa = m => { m.x = m.target; m.v = 0; };
  const ferma = (m, eps = 1e-3) => Math.abs(m.target - m.x) < eps && Math.abs(m.v) < eps;

  function rng(seme) { let a = seme >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // Obiettivi per stato. attivi: nodi astratti visibili; raggio: espansione della rete; anello: disposizione ad anello (verifica);
  // deforma: ampiezza delle deformazioni del nucleo; vel: velocita del suo "respiro"; luce: intensita; impulsi: impulsi al secondo;
  // flusso: verso degli impulsi (1 dal nucleo verso l'esterno, -1 verso il nucleo, 0 lungo la rete); colore: chiave della palette.
  const P = {
    // a riposo il nucleo resta vivo: deformazione e respiro visibili e tre satelliti in orbita stretta (rete astratta, non memoria)
    idle:             { attivi: 3,  raggio: .72,  anello: 0, deforma: .035, vel: .3, luce: .45, impulsi: 0,   flusso: 0,  colore: 'idle', nucleo: .85 },
    listening:        { attivi: 7,  raggio: .62,  anello: 0, deforma: .03,  vel: .5,  luce: .95, impulsi: .8,  flusso: -1, colore: 'listen', nucleo: 1 },
    thinking:         { attivi: 22, raggio: 1,    anello: 0, deforma: .075, vel: .55, luce: .75, impulsi: 2.2, flusso: 1,  colore: 'accent', nucleo: 1 },
    executing:        { attivi: 26, raggio: 1.05, anello: 0, deforma: .085, vel: .65, luce: .8,  impulsi: 3,   flusso: 1,  colore: 'accent', nucleo: 1 },
    retrieving:       { attivi: 14, raggio: 1.05, anello: 0, deforma: .06,  vel: .5,  luce: .85, impulsi: 3.2, flusso: -1, colore: 'accent', nucleo: 1 },
    tools:            { attivi: 9,  raggio: .72,  anello: 0, deforma: .05,  vel: .7,  luce: .8,  impulsi: 2.6, flusso: -1, colore: 'soft',   nucleo: 1 },
    quality_checking: { attivi: 20, raggio: 1,    anello: 1, deforma: .04,  vel: .35, luce: .8,  impulsi: 1.8, flusso: 0,  colore: 'verify', nucleo: 1 },
    escalating:       { attivi: 30, raggio: 1.22, anello: 0, deforma: .11,  vel: .9,  luce: 1,   impulsi: 3.6, flusso: 1,  colore: 'warn',   nucleo: 1 },
    speaking:         { attivi: 0,  raggio: 1,    anello: 0, deforma: .03,  vel: .45, luce: .7,  impulsi: 0,   flusso: 0,  colore: 'accent', nucleo: 1 },
    responding:       { attivi: 0,  raggio: 1,    anello: 0, deforma: .045, vel: .3,  luce: .5,  impulsi: 0,   flusso: 0,  colore: 'accent', nucleo: .85 },
    paused:           { attivi: 0,  raggio: 1,    anello: 0, deforma: .012, vel: .08, luce: .12, impulsi: 0,   flusso: 0,  colore: 'idle',  nucleo: .6 },
    error:            { attivi: 0,  raggio: 1,    anello: 0, deforma: .02,  vel: .15, luce: .5,  impulsi: 0,   flusso: 0,  colore: 'err',    nucleo: .9 }
  };
  const MAX_REALI = 12;

  // Geometria del contenitore in funzione dell'apertura (0 nucleo, 1 risposta). Funzione pura e continua in tutto [0,1]:
  // il disco del nucleo (diametro D) diventa il pannello W x H, mentre il nucleo si sposta nell'angolo e si rimpicciolisce.
  function geometriaPannello(ap, { D, W, H }) {
    const a = clamp(ap);
    const ew = lisc(0, .8, a), eh = lisc(.12, 1, a), mv = lisc(.1, 1, a);
    const w = lerp(D, W, ew), h = lerp(D, H, eh);
    const r = Math.min(lerp(D / 2, 30, lisc(0, .75, a)), w / 2, h / 2);
    return {
      w, h, r,
      cx: (-w / 2 + 36) * mv, cy: (-h / 2 + 34) * mv,            // posizione del nucleo rispetto al centro
      scala: lerp(1, .3, lisc(.08, .9, a)) * (1 + .1 * Math.sin(Math.PI * lisc(0, .45, a))),   // si gonfia un poco, poi si raccoglie
      testo: lisc(.62, 1, a), rivela: lisc(.7, 1, a)
    };
  }

  class Movimento {
    constructor({ nodi = 48, seme = 20240917 } = {}) {
      const r = rng(seme);
      this.rng = rng(seme ^ 0x5bd1e995);
      this.nodi = [];
      const oro = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < nodi; i++) {
        const y = 1 - (2 * (i + .5)) / nodi, rr = Math.sqrt(1 - y * y), th = oro * i;
        const dir = [Math.cos(th) * rr, y, Math.sin(th) * rr];
        this.nodi.push({
          dir, raggio: 1.75 + 1.55 * r(), ph: [r() * 6.28, r() * 6.28, r() * 6.28], w: [.3 + r() * .5, .25 + r() * .5, .3 + r() * .45],
          dim: .7 + r() * .6, e: molla(0, 2.6 + r() * 2.4, .95), reale: molla(0, 5, 1), th: molla(0, 3, 1), etichetta: null, pos: [0, 0, 0]
        });
      }
      // Ordine di attivazione fisso e sparso sulla sfera: aumentare i nodi attivi aggiunge nodi, non rimescola quelli presenti.
      const perm = this.nodi.map((_, i) => i);
      for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
      perm.forEach((n, k) => { this.nodi[n].rango = k; });
      // Topologia fissa: ogni nodo ai 2 piu vicini (sulla posizione di riposo) e al nucleo. Le linee cambiano intensita, non esistenza.
      const casa = this.nodi.map(n => n.dir.map(c => c * n.raggio));
      const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      const archi = [], visti = new Set();
      casa.forEach((p, i) => {
        casa.map((q, j) => ({ j, d: d2(p, q) })).filter(o => o.j !== i).sort((a, b) => a.d - b.d).slice(0, 2).forEach(({ j }) => {
          const k = Math.min(i, j) + ':' + Math.max(i, j); if (!visti.has(k)) { visti.add(k); archi.push({ i, j, cresce: 0 }); }
        });
        archi.push({ i, j: -1, cresce: 0 });
      });
      // Archi delle fonti: un risultato si collega allo strumento che lo ha restituito.
      // La riserva e allocata una volta; la geometria non viene ricreata durante il pensiero.
      for (let k = 0; k < MAX_REALI; k++) archi.push({ i: perm[k], j: -1, cresce: 0, fonte: true });
      this.archi = archi;
      this.impulsi = Array.from({ length: 40 }, () => ({ attivo: false, arco: 0, u: 0, vel: 1, verso: 1 }));
      this.accumulo = 0;

      const g = (x, w, z) => molla(x, w, z);
      this.m = {
        raggio: g(1, 3), anello: g(0, 2.6), deforma: g(.035, 2.2), luce: g(.35, 3), impulsi: g(0, 3), nucleo: g(.85, 3),
        vel: g(.22, 2), livello: g(0, 16, .95), scala: g(1, 7, .95), ap: g(0, 6.4, 1), W: g(560, 7), H: g(220, 7), kick: g(0, 9, .8)
      };
      this.tempo = 0; this.tRumore = 0; this.tDeriva = 0; this.tOrbita = 0; this.inizioStato = 0;
      this.nome = 'idle'; this.aperta = false; this.note = []; this.colore = 'accent'; this.flusso = 0; this.attivi = 0; this.reali = 0;
      this.imposta('idle');
      this.ridotto = false;
    }

    imposta(nome, note = [], connessioni = null, fallimento = false) {
      const p = P[nome] || P.idle;
      if (this.nome !== nome) this.inizioStato = this.tempo;
      this.nome = P[nome] ? nome : 'idle';
      const inLavoro = ['thinking', 'executing', 'retrieving', 'tools', 'quality_checking', 'escalating'].includes(nome);
      const fonti = connessioni && inLavoro ? connessioni.slice(0, MAX_REALI)
        : nome === 'retrieving' ? note.slice(0, MAX_REALI).map((titolo, i) => ({ id: 'nota:' + i, titolo: String(titolo), tipo: 'nota' })) : [];
      this.note = fonti.map(f => f.titolo);
      this.reali = fonti.length;
      this.attivi = p.attivi; this.flusso = p.flusso; this.colore = fallimento ? 'err' : p.colore;
      for (const k of ['raggio', 'anello', 'deforma', 'luce', 'impulsi', 'nucleo', 'vel']) this.m[k].target = p[k];
      for (const n of this.nodi) {
        const reale = n.rango < this.reali;
        n.reale.target = reale ? 1 : 0;
        n.etichetta = reale ? this.note[n.rango] : null;
        n.fonte = reale ? fonti[n.rango] : null;
      }
      const indici = new Map(this.nodi.filter(n => n.fonte).map(n => [n.fonte.id, this.nodi.indexOf(n)]));
      for (const a of this.archi) if (a.fonte) { const f = this.nodi[a.i].fonte; a.j = f && indici.has(f.padre) ? indici.get(f.padre) : -1; }
      this._obiettiviNodi();
      if (this.ridotto) this.fissaTutto();
    }
    apertura(aperta) { this.aperta = !!aperta; }
    geometria(W, H) { if (W > 0) this.m.W.target = W; if (H > 0) this.m.H.target = H; }
    livello(v) { this.m.livello.target = clamp(+v || 0); }
    impulso() { this.m.kick.v += 2.2; }

    _obiettiviNodi() {
      // La rete esiste solo a contenitore chiuso: se la risposta e aperta (o si sta aprendo) i nodi restano nel nucleo.
      const libera = this.m.ap.x < .3 && !this.aperta;
      const quanti = this.reali + this.attivi;
      const nAnello = Math.max(1, quanti);
      for (const n of this.nodi) {
        const progressivo = ['thinking', 'executing', 'retrieving', 'tools'].includes(this.nome) && !this.ridotto;
        const pronto = !progressivo || n.e.x > .02 || this.tempo >= this.inizioStato + n.rango * .035;
        const on = libera && n.rango < quanti && pronto;
        n.e.target = on ? 1 : 0;
        n.th.target = n.rango < this.reali ? 2 * Math.PI * n.rango / this.reali
          : (2 * Math.PI * Math.min(n.rango, nAnello)) / nAnello;
      }
    }
    emersioneMassima() { let m = 0; for (const n of this.nodi) m = Math.max(m, n.e.x); return m; }

    // Un passo di simulazione (dt in secondi). Con movimento ridotto tutto va subito all'obiettivo.
    passo(dt) {
      dt = Math.min(Math.max(dt, 0), .1);
      this.tempo += dt;
      // La risposta pronta non aspetta la rete; la chiusura conserva il rientro graduale.
      this.m.ap.target = this.aperta ? 1 : 0;
      this._obiettiviNodi();
      const liv = this.m.livello.x;
      const respiro = this.nome === 'idle' || this.nome === 'responding' || this.nome === 'paused' ? .03 * Math.sin(this.tempo * (this.nome === 'paused' ? .45 : 1.1)) : 0;
      this.m.scala.target = 1 + respiro + (this.nome === 'listening' ? .3 * liv : this.nome === 'speaking' ? .14 * liv : 0);
      if (this.ridotto) { this.fissaTutto(); return; }
      for (const k in this.m) passoMolla(this.m[k], dt);
      for (const n of this.nodi) { passoMolla(n.e, dt); passoMolla(n.reale, dt); passoMolla(n.th, dt); }
      // Il tempo del rumore avanza con la velocita CORRENTE (molla): cambiare stato non fa mai saltare la forma.
      this.tRumore += dt * (this.m.vel.x + .9 * liv);
      this.tDeriva += dt;                    // moto secondario, indipendente dallo stato
      this.tOrbita += dt * .4 * this.m.anello.x;
      for (const a of this.archi) {          // le linee crescono lungo il loro percorso, non compaiono di colpo
        const eA = this.nodi[a.i].e.x, eB = a.j < 0 ? 1 : this.nodi[a.j].e.x;
        const collegabile = a.fonte ? !!this.nodi[a.i].fonte : !this.nodi[a.i].fonte && (a.j < 0 || !this.nodi[a.j].fonte);
        const obi = collegabile ? lisc(.25, .95, Math.min(eA, eB)) : 0;
        a.cresce += (obi - a.cresce) * (1 - Math.exp(-dt * 5));
      }
      this._impulsi(dt);
    }

    fissaTutto() {
      for (const k in this.m) fissa(this.m[k]);
      this.m.ap.target = this.aperta ? 1 : 0; fissa(this.m.ap);
      this._obiettiviNodi();
      for (const n of this.nodi) { fissa(n.e); fissa(n.reale); fissa(n.th); }
      for (const a of this.archi) {
        const collegabile = a.fonte ? !!this.nodi[a.i].fonte : !this.nodi[a.i].fonte && (a.j < 0 || !this.nodi[a.j].fonte);
        a.cresce = collegabile ? lisc(.25, .95, Math.min(this.nodi[a.i].e.x, a.j < 0 ? 1 : this.nodi[a.j].e.x)) : 0;
      }
      for (const p of this.impulsi) p.attivo = false;
    }

    // Nulla si muove piu (escluso il moto lento di fondo): il disegno puo rallentare.
    aRiposo() {
      for (const k in this.m) if (k !== 'scala' && !ferma(this.m[k])) return false;
      return this.nodi.every(n => ferma(n.e) && ferma(n.reale)) && this.impulsi.every(p => !p.attivo);
    }

    _impulsi(dt) {
      for (const p of this.impulsi) {
        if (!p.attivo) continue;
        p.u += dt * p.vel;
        const a = this.archi[p.arco];
        if (p.u >= 1 || !a || a.cresce < .5) p.attivo = false;
      }
      const tasso = this.m.impulsi.x * lisc(.3, .9, this.emersioneMassima());
      this.accumulo += dt * tasso;
      while (this.accumulo >= 1) {
        this.accumulo -= 1;
        const libero = this.impulsi.find(p => !p.attivo); if (!libero) break;
        // Nel recupero dalle note gli impulsi partono dai nodi reali (l'informazione arriva al nucleo); altrimenti da archi visibili.
        const candidati = [];
        this.archi.forEach((a, k) => { if (a.cresce > .8 && (!this.reali || this.nodi[a.i].reale.x > .5 || this.rng() < .35)) candidati.push(k); });
        if (!candidati.length) break;
        const k = candidati[Math.floor(this.rng() * candidati.length)], a = this.archi[k];
        let verso = this.flusso === 0 ? (this.rng() < .5 ? 1 : -1) : this.flusso;
        if (a.j >= 0) verso = (this.nodi[a.i].raggio < this.nodi[a.j].raggio ? 1 : -1) * (this.flusso === 0 ? 1 : this.flusso);
        Object.assign(libero, { attivo: true, arco: k, u: 0, vel: .7 + this.rng() * .7, verso });
      }
    }

    // Posizione di un nodo in unita di raggio del nucleo, rispetto al suo centro. Continua nel tempo per costruzione.
    posizione(n, out = n.pos) {
      const e = clamp(n.e.x, 0, 1.08), s = this.m.scala.x, R = this.m.raggio.x, T = this.tDeriva;
      const dx = .1 * Math.sin(T * n.w[0] + n.ph[0]), dy = .1 * Math.sin(T * n.w[1] + n.ph[1]), dz = .1 * Math.sin(T * n.w[2] + n.ph[2]);
      const hr = n.raggio * R * (1 + .1 * n.reale.x);
      const hx = n.dir[0] * hr + dx, hy = n.dir[1] * hr + dy, hz = n.dir[2] * hr + dz;
      const th = n.th.x + this.tOrbita, rr = 2.35 * R;
      const an = this.m.anello.x;
      const tx = lerp(hx, Math.cos(th) * rr, an), ty = lerp(hy, Math.sin(th) * rr * .62 + dy * .5, an), tz = lerp(hz, Math.sin(th) * rr * .78, an);
      // Uscita dal nucleo lungo un arco (non una retta): spostamento laterale massimo a meta percorso.
      const sx = n.dir[0] * s, sy = n.dir[1] * s, sz = n.dir[2] * s;
      let px = -n.dir[2], pz = n.dir[0]; const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
      const arco = .38 * Math.sin(Math.PI * clamp(e));
      out[0] = sx + (tx - sx) * e + px * arco; out[1] = sy + (ty - sy) * e; out[2] = sz + (tz - sz) * e + pz * arco;
      return out;
    }

    // Istantanea per il disegno e per i test.
    istantanea({ D } = { D: 110 }) {
      for (const n of this.nodi) this.posizione(n);
      return {
        nome: this.nome, colore: this.colore, tRumore: this.tRumore, tempo: this.tempo,
        deforma: this.m.deforma.x + this.m.livello.x * (this.nome === 'listening' ? .1 :this.nome === 'speaking' ? .07 : 0) + .05 * Math.max(0, this.m.kick.x),
        luce: this.m.luce.x + (this.nome === 'listening' ? this.m.livello.x * .8 : 0), nucleo: this.m.nucleo.x, scala: this.m.scala.x * (1 + .04 * this.m.kick.x),
        ap: this.m.ap.x, pannello: geometriaPannello(this.m.ap.x, { D, W: this.m.W.x, H: this.m.H.x }),
        emersione: this.emersioneMassima(), reali: this.nodi.filter(n => n.reale.x > .5 && n.e.x > .5).length
      };
    }
  }

  const api = { Movimento, molla, passoMolla, geometriaPannello, PARAMETRI: P, lisc, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OrbitMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
