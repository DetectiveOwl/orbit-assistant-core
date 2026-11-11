// Orbit Core: il nucleo 3D, la rete e il contenitore della risposta come UN solo oggetto (Three.js r170, copia locale in /vendor).
// Il movimento viene tutto da OrbitMotion (orbit-motion.js): qui si disegna soltanto quello che la simulazione dice.
// Questo modulo SOLO rappresenta lo stato ricevuto: non decide mai se un'operazione e finita o riuscita.
//  - rete astratta (pensiero, esecuzione, verifica...): nodi piccoli e tenui, SENZA etichette, non dicono di aver letto note;
//  - nodi reali (solo nello stato 'retrieving' con note davvero recuperate): pieni, piu grandi, con il titolo della nota.
// Risorse: un solo renderer e una sola scena creati una volta; un solo ciclo requestAnimationFrame (mai duplicato);
// a riposo il ciclo scende a 30 fotogrammi al secondo, a pagina nascosta si ferma, con "riduci movimento" disegna solo ai cambi.
// Senza WebGL resta il nucleo SVG con le sue animazioni CSS e il contenitore continua a usare la stessa simulazione.
import * as THREE from '/vendor/three.module.min.js';

const { Movimento } = window.OrbitMotion;

const SVG = `
<svg viewBox="0 0 120 120" role="img" aria-label="Orbit" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="oc-sfera" cx="35%" cy="30%" r="80%">
      <stop offset="0%" stop-color="var(--core-hi)"/><stop offset="55%" stop-color="var(--core-mid)"/><stop offset="100%" stop-color="var(--core-lo)"/>
    </radialGradient>
    <filter id="oc-ombra" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="3" dy="4" stdDeviation="4" flood-color="var(--shadow-dark)" flood-opacity=".6"/>
      <feDropShadow dx="-3" dy="-3" stdDeviation="3.5" flood-color="var(--shadow-light)" flood-opacity=".9"/>
    </filter>
  </defs>
  <g class="oc-corpo">
    <circle class="oc-alone" cx="60" cy="60" r="56" fill="var(--accent)" opacity=".10"/>
    <circle class="oc-sfera" cx="60" cy="60" r="38" fill="url(#oc-sfera)" filter="url(#oc-ombra)"/>
    <circle class="oc-nucleo" cx="60" cy="60" r="14" fill="var(--accent)"/>
    <circle class="oc-riflesso" cx="50" cy="49" r="5.5" fill="#fff" opacity=".4"/>
  </g>
</svg>`;

// Rumore simplex 3D (Ashima Arts / Stefan Gustavson, licenza MIT).
const RUMORE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 q0=vec3(a0.xy,h.x); vec3 q1=vec3(a0.zw,h.y); vec3 q2=vec3(a1.xy,h.z); vec3 q3=vec3(a1.zw,h.w);
  vec4 nr=taylorInvSqrt(vec4(dot(q0,q0),dot(q1,q1),dot(q2,q2),dot(q3,q3)));
  q0*=nr.x; q1*=nr.y; q2*=nr.z; q3*=nr.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(q0,x0),dot(q1,x1),dot(q2,x2),dot(q3,x3)));
}`;

// Nucleo: guscio perlato che si deforma con un rumore continuo; dal centro traspare il nucleo colorato.
const NUCLEO_VS = RUMORE + `
uniform float uT; uniform float uAmp;
varying vec3 vN; varying vec3 vV; varying float vD; varying vec3 vN0;
float spost(vec3 p){ return snoise(p*1.7+vec3(0.0,uT*0.6,uT))*uAmp + snoise(p*3.6-vec3(uT*0.45))*uAmp*0.32; }
void main(){
  vec3 n=normalize(position);
  vec3 t=normalize(cross(n, abs(n.y)<0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));
  vec3 b=cross(n,t);
  float d0=spost(n);
  vec3 p0=n*(1.0+d0);
  vec3 n1=normalize(n+t*0.012); vec3 p1=n1*(1.0+spost(n1));
  vec3 n2=normalize(n+b*0.012); vec3 p2=n2*(1.0+spost(n2));
  vec3 nn=normalize(cross(p1-p0,p2-p0)); if(dot(nn,n)<0.0) nn=-nn;
  vD=d0;
  vec4 mv=modelViewMatrix*vec4(p0,1.0);
  vV=-mv.xyz; vN=normalize(normalMatrix*nn); vN0=normalize(normalMatrix*n);
  gl_Position=projectionMatrix*mv;
}`;
const NUCLEO_FS = `
uniform vec3 uHi; uniform vec3 uMid; uniform vec3 uLo; uniform vec3 uCol; uniform float uLuce; uniform float uNucleo; uniform float uAmp; uniform float uT;
varying vec3 vN; varying vec3 vV; varying float vD; varying vec3 vN0;
void main(){
  vec3 N=normalize(vN); vec3 V=normalize(vV);
  vec3 L=normalize(vec3(-0.55,0.62,0.56));           // luce da in alto a sinistra, come le ombre neumorfiche
  float nv=max(dot(N,V),0.0);
  float nv0=max(dot(normalize(vN0),V),0.0);          // il nucleo interno resta tondo: usa la sfera non deformata
  float dif=max(dot(N,L),0.0);
  vec3 p=normalize(vN0);
  float onda=sin(p.y*7.0+p.x*3.0+sin(p.z*5.0+p.x*2.0+uT*.24)*1.5+uT*.3);
  float filamento=pow(1.0-abs(onda),9.0);
  float seta=pow(.5+.5*sin(p.y*13.0-p.x*4.0+sin(p.z*4.0-uT*.16)*2.0),6.0);
  vec3 guscio=mix(uLo,uMid,clamp(dif*.5+.24+onda*.14,0.0,1.0));
  vec3 col=mix(guscio,uHi,filamento*.55+seta*.18);
  float bordo=pow(1.0-nv,3.2);
  col=mix(col,uCol,(filamento*.22+bordo*.72)*uNucleo);
  col+=uCol*bordo*.35*uLuce;
  float spec=pow(max(dot(N,normalize(L+V)),0.0),64.0);
  col+=uHi*spec*.5;
  gl_FragColor=vec4(col,1.0);
}`;

// Punti (nodi e impulsi): dimensione in pixel con prospettiva, piu tenui in profondita (parallasse e profondita reali).
const PUNTI_VS = `
attribute float aAlfa; attribute float aDim; attribute float aReale;
uniform float uPx; uniform float uZ; uniform float uSpan;
varying float vAlfa; varying float vReale;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  gl_Position=projectionMatrix*mv;
  float prof=clamp((-mv.z-(uZ-uSpan))/(2.0*uSpan),0.0,1.0);
  gl_PointSize=aDim*uPx*(uZ/-mv.z);
  vAlfa=aAlfa*mix(1.0,0.45,prof); vReale=aReale;
}`;
const PUNTI_FS = `
uniform vec3 uCol; uniform vec3 uColReale;
varying float vAlfa; varying float vReale;
void main(){
  float d=length(gl_PointCoord-0.5);
  float a=(1.0-smoothstep(0.18,0.5,d))+vReale*(1.0-smoothstep(0.0,0.5,d))*0.25;
  if(a*vAlfa<0.004) discard;
  gl_FragColor=vec4(mix(uCol,uColReale,vReale),a*vAlfa);
}`;
const LINEE_VS = `
attribute float aAlfa; uniform float uZ; uniform float uSpan; varying float vAlfa;
void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
  float prof=clamp((-mv.z-(uZ-uSpan))/(2.0*uSpan),0.0,1.0); vAlfa=aAlfa*mix(1.0,0.4,prof); }`;
const LINEE_FS = `uniform vec3 uCol; varying float vAlfa; void main(){ if(vAlfa<0.003) discard; gl_FragColor=vec4(uCol,vAlfa); }`;

const CAM_Z = 10, FOV = 30;
const MAX_ETICHETTE = 12;
const SEGMENTI = 12;

function leggiColori() {
  const cs = getComputedStyle(document.documentElement);
  const c = (n, d) => { const v = cs.getPropertyValue(n).trim(); try { return new THREE.Color(v || d); } catch (e) { return new THREE.Color(d); } };
  // Il nucleo ha colori suoi, separati dall'accento dell'interfaccia: sempre viola, rosso solo se qualcosa fallisce.
  return {
    accent: c('--core-lavoro', '#8b5cf6'), idle: c('--core-idle', '#a47ef0'), listen: c('--core-listen', '#c39bff'), soft: c('--core-strumenti', '#b794f6'), verify: c('--core-verifica', '#c4a1ff'), warn: c('--core-escalation', '#d17cff'),
    err: c('--core-errore', '#ff4d5e'), tenue: c('--text-3', '#8b93a3'), hi: c('--core-hi', '#f4ecff'), mid: c('--core-mid', '#e1e5ee'), lo: c('--core-lo', '#c6ccdc')
  };
}

// elementi: { svg, canvas, radice, scena, corpo, nucleo, etichette, suChiusa }
function crea({ svg, canvas, radice, scena, corpo, nucleo, etichette, suChiusa }) {
  svg.innerHTML = SVG;
  radice.dataset.stato = 'idle';
  const mov = new Movimento();
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let scelta = 'auto';
  const ridotto = () => scelta === 'ridotto' || (scelta === 'auto' && !!(mq && mq.matches));
  let nascosta = false, raf = 0, timer = 0, ultimo = 0, perso = false, apVisto = 0;
  let D = 110, k = 1, ox = 0, oy = 0, dprMax = Math.min(window.devicePixelRatio || 1, 2), dpr = dprMax, medio = 1 / 60, campioni = 0;
  const par = { x: 0, y: 0, tx: 0, ty: 0 };
  const scritti = {};
  let palette = leggiColori();
  const col = { cur: palette.idle.clone(), hi: palette.hi.clone(), mid: palette.mid.clone(), lo: palette.lo.clone() };
  const cibleHi = new THREE.Color(), cibleMid = new THREE.Color(), cibleLo = new THREE.Color();

  // ---------- scena (creata una volta) ----------
  let renderer = null, scene, camera, gruppo, sfera, punti, linee, impulsi, uNucleo, uPunti, uImpulsi, uLinee;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'default', premultipliedAlpha: true });
    THREE.ColorManagement.enabled = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, 1, .1, 100); camera.position.set(0, 0, CAM_Z);
    gruppo = new THREE.Group(); scene.add(gruppo);

    uNucleo = { uT: { value: 0 }, uAmp: { value: .035 }, uHi: { value: col.hi }, uMid: { value: col.mid }, uLo: { value: col.lo }, uCol: { value: col.cur }, uLuce: { value: .35 }, uNucleo: { value: .85 } };
    sfera = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 30), new THREE.ShaderMaterial({ uniforms: uNucleo, vertexShader: NUCLEO_VS, fragmentShader: NUCLEO_FS }));
    gruppo.add(sfera);

    const N = mov.nodi.length, A = mov.archi.length, I = mov.impulsi.length;
    const comuni = { uZ: { value: CAM_Z }, uSpan: { value: 1 } };
    const nuovaGeo = (n, attr) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage)); for (const a of attr) g.setAttribute(a, new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage)); return g; };
    const matPunti = u => new THREE.ShaderMaterial({ uniforms: u, vertexShader: PUNTI_VS, fragmentShader: PUNTI_FS, transparent: true, depthWrite: false });

    uPunti = Object.assign({ uPx: { value: 1 }, uCol: { value: col.cur }, uColReale: { value: col.cur } }, comuni);
    punti = new THREE.Points(nuovaGeo(N, ['aAlfa', 'aDim', 'aReale']), matPunti(uPunti)); punti.frustumCulled = false; gruppo.add(punti);
    uImpulsi = Object.assign({ uPx: { value: 1 }, uCol: { value: col.cur }, uColReale: { value: col.cur } }, comuni);
    impulsi = new THREE.Points(nuovaGeo(I, ['aAlfa', 'aDim', 'aReale']), matPunti(uImpulsi)); impulsi.frustumCulled = false; gruppo.add(impulsi);
    uLinee = Object.assign({ uCol: { value: col.cur } }, comuni);
    linee = new THREE.LineSegments(nuovaGeo(A * SEGMENTI * 2, ['aAlfa']), new THREE.ShaderMaterial({ uniforms: uLinee, vertexShader: LINEE_VS, fragmentShader: LINEE_FS, transparent: true, depthWrite: false }));
    linee.frustumCulled = false; gruppo.add(linee);
    // ordine: linee sotto, poi nodi e impulsi; la sfera scrive la profondita e copre cio che sta dietro
    linee.renderOrder = 1; punti.renderOrder = 2; impulsi.renderOrder = 3;

    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); perso = true; ferma(); radice.classList.add('senza-webgl'); });
    canvas.addEventListener('webglcontextrestored', () => { perso = false; radice.classList.remove('senza-webgl'); programma(); });
  } catch (e) {
    renderer = null;
    radice.classList.add('senza-webgl');
  }

  // ---------- etichette dei nodi reali (HTML, leggibili e accessibili) ----------
  const etich = [];
  for (let i = 0; i < MAX_ETICHETTE; i++) { const s = document.createElement('span'); s.className = 'etichetta'; s.hidden = true; etichette.appendChild(s); etich.push(s); }

  function misura() {
    const w = window.innerWidth, h = window.innerHeight;
    D = Math.min(h <= 640 ? 122 : 164, w * .34);
    k = (2 * CAM_Z * Math.tan((FOV / 2) * Math.PI / 180)) / h;     // unita del mondo per pixel sul piano del nucleo
    const r = radice.getBoundingClientRect();
    ox = r.left + r.width / 2 - w / 2; oy = r.top + r.height / 2 - h / 2;
    if (renderer) { renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  }

  const imposta = (el, prop, val, soglia = .25) => { const key = prop; const v = Math.round(val * 100) / 100; if (scritti[el.id + key] !== undefined && Math.abs(scritti[el.id + key] - v) < soglia) return; scritti[el.id + key] = v; el.style.setProperty(prop, prop.startsWith('--') && prop !== '--semi' ? String(v) : v + 'px'); };

  // ---------- un fotogramma ----------
  const tmp = new THREE.Vector3();
  const arcoP = [0, 0, 0], arcoQ = [0, 0, 0];
  // Linee e impulsi percorrono la stessa curva: nessun salto tra il collegamento e il suo segnale.
  function puntoArco(a, u, s, out) {
    const A = mov.nodi[a.i], B = a.j < 0 ? null : mov.nodi[a.j];
    const sx = B ? A.pos[0] : A.dir[0] * s.scala, sy = B ? A.pos[1] : A.dir[1] * s.scala, sz = B ? A.pos[2] : A.dir[2] * s.scala;
    const end = B ? B.pos : A.pos;
    const dx = end[0] - sx, dy = end[1] - sy, dz = end[2] - sz;
    const norm = Math.hypot(dx, dy) || 1;
    const arco = Math.sin(Math.PI * u) * Math.hypot(dx, dy, dz) * .12;
    out[0] = sx + dx * u - dy / norm * arco;
    out[1] = sy + dy * u + dx / norm * arco;
    out[2] = sz + dz * u + arco * .18;
    return out;
  }
  function disegna(dt) {
    const s = mov.istantanea({ D });
    const pan = s.pannello;
    // DOM: contenitore, pulsante del nucleo, testo, posizione degli elementi sotto. Stessa simulazione, stesso istante.
    imposta(corpo, 'width', pan.w); imposta(corpo, 'height', pan.h); imposta(corpo, 'border-radius', pan.r);
    const dB = D * pan.scala;
    imposta(nucleo, 'left', pan.w / 2 + pan.cx); imposta(nucleo, 'top', pan.h / 2 + pan.cy); imposta(nucleo, 'width', dB); imposta(nucleo, 'height', dB);
    imposta(radice, '--testo', pan.testo, .01); imposta(radice, '--rivela', pan.rivela, .01); imposta(radice, '--ap', s.ap, .005);
    const base = window.innerHeight <= 640 ? 150 : 190;
    imposta(scena, '--semi', base + Math.max(0, mov.m.H.x / 2 + 20 - base) * s.ap); imposta(scena, '--ap', s.ap, .005);
    radice.classList.toggle('aperta-vis', s.ap > .02);
    if (apVisto > .001 && s.ap <= .001 && !mov.aperta && suChiusa) suChiusa();
    apVisto = s.ap;

    // colori: inseguono la palette dello stato, mai cambi istantanei
    const f = 1 - Math.exp(-(dt || 1) * 4);
    const tinta = palette[s.colore] || palette.accent;
    col.cur.lerp(tinta, f);
    cibleHi.copy(palette.hi).lerp(tinta, .6); cibleMid.copy(tinta).multiplyScalar(.44); cibleLo.copy(tinta).multiplyScalar(.09);
    col.hi.lerp(cibleHi, f); col.mid.lerp(cibleMid, f); col.lo.lerp(cibleLo, f);
    const coloreCss = '#' + col.cur.getHexString();
    if (radice.style.getPropertyValue('--state-color') !== coloreCss) radice.style.setProperty('--state-color', coloreCss);
    imposta(radice, '--energia', s.luce, .025);

    if (!renderer || perso) { aggiornaEtichette(s, null); return; }
    // parallasse: il puntatore inclina appena la scena; il moto lento di fondo resta indipendente
    const fp = 1 - Math.exp(-(dt || 1) * 2.5); par.x += (par.tx - par.x) * fp; par.y += (par.ty - par.y) * fp;
    const Rw = D * .4 * k;                                          // raggio del nucleo nel mondo
    gruppo.position.set((ox + pan.cx) * k, -(oy + pan.cy) * k, 0);
    gruppo.scale.setScalar(Rw * pan.scala);
    gruppo.rotation.set(.22 + par.y * .35 + .05 * Math.sin(s.tempo * .13), s.tempo * .11 + par.x * .5, 0);
    sfera.scale.setScalar(s.scala);
    uNucleo.uT.value = s.tRumore; uNucleo.uAmp.value = s.deforma; uNucleo.uLuce.value = s.luce; uNucleo.uNucleo.value = s.nucleo;
    const span = 3.6 * Rw; uPunti.uSpan.value = span; uPunti.uPx.value = dpr;

    const N = mov.nodi, pos = punti.geometry.attributes.position.array, al = punti.geometry.attributes.aAlfa.array, dm = punti.geometry.attributes.aDim.array, re = punti.geometry.attributes.aReale.array;
    for (let i = 0; i < N.length; i++) {
      const n = N[i], e = Math.max(0, Math.min(1, n.e.x));
      pos[i * 3] = n.pos[0]; pos[i * 3 + 1] = n.pos[1]; pos[i * 3 + 2] = n.pos[2];
      al[i] = e * (.62 + .38 * n.reale.x) * (.6 + .4 * s.luce);
      dm[i] = (3 + 2 * n.dim) * (1 - n.reale.x) + 12 * n.reale.x;
      re[i] = n.reale.x;
    }
    for (const a of ['position', 'aAlfa', 'aDim', 'aReale']) punti.geometry.attributes[a].needsUpdate = true;

    const lp = linee.geometry.attributes.position.array, la = linee.geometry.attributes.aAlfa.array;
    mov.archi.forEach((a, j) => {
      const nA = N[a.i], g = a.cresce;
      const reale = a.j < 0 ? nA.reale.x : Math.max(nA.reale.x, N[a.j].reale.x);
      const v = g * (a.fonte ? .5 : .2) * (.6 + .6 * s.luce) * (1 + .45 * reale);
      for (let k2 = 0; k2 < SEGMENTI; k2++) {
        puntoArco(a, k2 / SEGMENTI * g, s, arcoP); puntoArco(a, (k2 + 1) / SEGMENTI * g, s, arcoQ);
        const at = (j * SEGMENTI + k2) * 6, ai = (j * SEGMENTI + k2) * 2;
        lp[at] = arcoP[0]; lp[at + 1] = arcoP[1]; lp[at + 2] = arcoP[2];
        lp[at + 3] = arcoQ[0]; lp[at + 4] = arcoQ[1]; lp[at + 5] = arcoQ[2];
        la[ai] = v; la[ai + 1] = v;
      }
    });
    linee.geometry.attributes.position.needsUpdate = true; linee.geometry.attributes.aAlfa.needsUpdate = true;

    const ip = impulsi.geometry.attributes.position.array, ia = impulsi.geometry.attributes.aAlfa.array, id = impulsi.geometry.attributes.aDim.array;
    mov.impulsi.forEach((p, j) => {
      if (!p.attivo) { ia[j] = 0; return; }
      const a = mov.archi[p.arco];
      const u = p.verso > 0 ? p.u : 1 - p.u;
      puntoArco(a, u, s, arcoP);
      ip[j * 3] = arcoP[0]; ip[j * 3 + 1] = arcoP[1]; ip[j * 3 + 2] = arcoP[2];
      ia[j] = Math.sin(Math.PI * p.u) * .95 * a.cresce; id[j] = 5.5;
    });
    for (const a of ['position', 'aAlfa', 'aDim']) impulsi.geometry.attributes[a].needsUpdate = true;
    uImpulsi.uSpan.value = span; uImpulsi.uPx.value = dpr; uLinee.uSpan.value = span;

    renderer.render(scene, camera);
    aggiornaEtichette(s, Rw);
  }

  function aggiornaEtichette(s, Rw) {
    let k2 = 0;
    const posizioni = [];
    if (Rw) {
      gruppo.updateMatrixWorld();
      for (const n of mov.nodi) {
        if (!n.etichetta || n.e.x < .55 || k2 >= MAX_ETICHETTE) continue;
        tmp.set(n.pos[0], n.pos[1], n.pos[2]).applyMatrix4(gruppo.matrixWorld).project(camera);
        const x = (tmp.x * .5 + .5) * window.innerWidth, y = (-tmp.y * .5 + .5) * window.innerHeight;
        const el = etich[k2++], destra = x >= window.innerWidth / 2 + ox;
          if (el.textContent !== n.etichetta) el.textContent = n.etichetta;
          el.title = n.etichetta;
          el.dataset.esito = n.fonte?.stato || '';
        el.hidden = false; el.classList.toggle('sinistra', !destra);
          const larghezza = Math.min(145, window.innerWidth * .36);
          const px = destra ? Math.min(window.innerWidth - larghezza - 16, x + 10) : Math.max(larghezza + 16, x - 10);
          posizioni.push({el, px, y: Math.max(100, Math.min(window.innerHeight - 165, y - 8)), destra});
        el.style.opacity = String(Math.min(1, (n.e.x - .55) / .35) * .9);
      }
    }
    for (const lato of [false, true]) {
      const gruppoEtichette = posizioni.filter(p => p.destra === lato).sort((a, b) => a.y - b.y);
      let precedente = 72;
      for (const p of gruppoEtichette) { p.y = Math.max(p.y, precedente + 28); precedente = p.y; }
      const eccesso = Math.max(0, precedente - (window.innerHeight - 165));
      for (const p of gruppoEtichette) p.el.style.transform = 'translate(' + Math.round(p.px) + 'px,' + Math.round(p.y - eccesso) + 'px)' + (p.destra ? '' : ' translateX(-100%)');
    }
    for (; k2 < MAX_ETICHETTE; k2++) etich[k2].hidden = true;
  }

  // ---------- ciclo unico ----------
  function ferma() { if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); raf = 0; timer = 0; }
  function programma() {
    if (raf || timer || nascosta || perso) return;
    if (mov.ridotto) { mov.passo(0); disegna(0); return; }
    raf = requestAnimationFrame(ciclo);
  }
  function ciclo(ts) {
    raf = 0;
    if (nascosta || perso) return;
    const dt = ultimo ? Math.min(.1, (ts - ultimo) / 1000) : 1 / 60; ultimo = ts;
    mov.passo(dt); disegna(dt);
    // qualita adattiva: se i fotogrammi sono lenti si abbassa la risoluzione, non la fluidita
    // (i fotogrammi rallentati dal browser, finestra coperta o in secondo piano, non contano: non sono lentezza del disegno)
    if (dt < .06) { medio = medio * .95 + dt * .05; if (++campioni > 90 && medio > .026 && dpr > 1) { dpr = Math.max(1, dpr - .25); campioni = 0; misura(); } }
    // Sempre alla frequenza dello schermo: costa circa 0,2 ms per fotogramma, e a pagina nascosta il ciclo si ferma comunque.
    raf = requestAnimationFrame(ciclo);
  }

  function aggiornaMovimento() {
    mov.ridotto = ridotto();
    radice.classList.toggle('movimento-ridotto', mov.ridotto); document.documentElement.classList.toggle('movimento-ridotto', mov.ridotto);
    ferma(); ultimo = 0; programma();
  }
  if (mq) (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(aggiornaMovimento);
  // tema automatico: se cambia il tema del sistema, i colori del nucleo lo seguono (in modo graduale, come ogni altro colore)
  const mqScuro = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mqScuro && mqScuro.addEventListener) mqScuro.addEventListener('change', () => { palette = leggiColori(); programma(); });
  function visibilita() {
    nascosta = document.visibilityState !== 'visible';
    radice.classList.toggle('in-background', nascosta);
    if (nascosta) ferma(); else { ultimo = 0; programma(); }
  }
  const suRidimensiona = () => { misura(); ultimo = 0; ferma(); programma(); };
  const suPuntatore = e => { par.tx = (e.clientX / window.innerWidth - .5); par.ty = (e.clientY / window.innerHeight - .5); };
  document.addEventListener('visibilitychange', visibilita);
  window.addEventListener('resize', suRidimensiona);
  window.addEventListener('pointermove', suPuntatore, { passive: true });
  misura();
  mov.ridotto = ridotto();
  radice.classList.toggle('movimento-ridotto', mov.ridotto); document.documentElement.classList.toggle('movimento-ridotto', mov.ridotto);
  visibilita();

  const cambia = () => { if (mov.ridotto) { ferma(); programma(); } else programma(); };
  return {
    // stato: oggetto della macchina a stati ({ nome, note })
    imposta(stato) { radice.dataset.stato = stato.nome; radice.dataset.fallimento = String(!!stato.fallimento); mov.imposta(stato.nome, stato.note || [], stato.connessioni || [], stato.fallimento); cambia(); },
    apertura(aperta) { mov.apertura(aperta); cambia(); },
    geometria(W, H) { mov.geometria(W, H); cambia(); },
    livello(v) { mov.livello(v); radice.style.setProperty('--livello', String(Math.max(0, Math.min(1, v)).toFixed(3))); cambia(); },
    impulso() { mov.impulso(); cambia(); },
    temaCambiato() { palette = leggiColori(); cambia(); },
    ricentra() { misura(); cambia(); },
    diagnostica() {
      const s = mov.istantanea({ D });
      return { modo: mov.nome, intensita: +s.emersione.toFixed(2), nodi: mov.nodi.filter(n => n.e.x > .5).length, reali: s.reali, ap: +s.ap.toFixed(3),
        ciclo: !!(raf || timer), ridotto: mov.ridotto, nascosta, webgl: !!renderer && !perso, dpr, msFotogramma: +(medio * 1000).toFixed(1) };
    },
    // Solo per prove e diagnostica: avanza la simulazione di n passi e disegna ogni passo (anche a pagina nascosta o con movimento ridotto).
    forzaMovimento(si) { scelta = si ? 'completo' : 'auto'; aggiornaMovimento(); },
    // Preferenza "Movimento" di Orbit: 'auto' segue Windows (effetti di animazione), 'completo' sempre fluido, 'ridotto' fotogrammi fermi.
    movimento(v) { scelta = ['auto', 'completo', 'ridotto'].includes(v) ? v : 'auto'; aggiornaMovimento(); },
    avanza(n = 1, dt = 1 / 60) { const r = mov.ridotto; mov.ridotto = false; for (let i = 0; i < n; i++) { mov.passo(dt); disegna(dt); } mov.ridotto = r; return this.diagnostica(); },
    distruggi() {
      ferma();
      document.removeEventListener('visibilitychange', visibilita); window.removeEventListener('resize', suRidimensiona); window.removeEventListener('pointermove', suPuntatore);
      if (renderer) { for (const o of [sfera, punti, impulsi, linee]) { o.geometry.dispose(); o.material.dispose(); } renderer.dispose(); }
    }
  };
}

window.OrbitCore = { crea };
export { crea };
