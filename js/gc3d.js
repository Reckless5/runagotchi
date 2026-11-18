/* Runagotchi retro 3D style kit — the look of early-2000s console games:
   painted textures with soft filtering, vertex-lit (Gouraud) materials, a painted sky dome,
   distance haze, blob shadows instead of real shadows, frond-card palm trees.
   Shared by the garden (garden3d.js) and the Crew run (crew3d.js). Everything is procedural,
   so the artist's .glb models can replace any prop later. */
import * as THREE from '../vendor/three.js';

/* ---------- one renderer for both scenes (only one is on screen at a time) ---------- */
let R = null;
export function renderer() {
  if (R === false) return null;
  if (!R) {
    try {
      R = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
      R.outputColorSpace = THREE.SRGBColorSpace;
      R.setPixelRatio(Math.min(1.25, window.devicePixelRatio || 1));   // a little soft, like a TV-era console — and cheap
      R.domElement.className = 'g3d-canvas';
    } catch (e) { R = false; return null; }
  }
  return R;
}

/* ---------- small helpers ---------- */
let seed = 7;
export const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
export const rr = (a, b) => a + rand() * (b - a);
function tex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
const speckle = (x, w, h, n, colors, rmin, rmax, alpha = 1) => {
  for (let i = 0; i < n; i++) { x.globalAlpha = alpha * rr(0.4, 1); x.fillStyle = colors[i % colors.length]; x.beginPath(); x.ellipse(rr(0, w), rr(0, h), rr(rmin, rmax), rr(rmin, rmax) * rr(0.5, 1), rr(0, 3), 0, 7); x.fill(); }
  x.globalAlpha = 1;
};
const CACHE = {};
const once = (k, f) => CACHE[k] || (CACHE[k] = f());

/* ---------- painted textures ---------- */
export const TEX = {
  grass: () => once('grass', () => tex(256, 256, (x, w, h) => {
    x.fillStyle = '#5fbf45'; x.fillRect(0, 0, w, h);
    speckle(x, w, h, 90, ['#4fae3a', '#6fcd50', '#57b73f'], 10, 26, 0.55);
    x.lineWidth = 2;
    for (let i = 0; i < 900; i++) { const px = rr(0, w), py = rr(0, h); x.strokeStyle = ['#3e9a30', '#7ad85a', '#4aa83a', '#8be36a'][i % 4]; x.globalAlpha = rr(0.4, 0.9); x.beginPath(); x.moveTo(px, py); x.lineTo(px + rr(-2, 2), py - rr(3, 7)); x.stroke(); }
    x.globalAlpha = 1;
  })),
  sand: () => once('sand', () => tex(128, 128, (x, w, h) => { x.fillStyle = '#e6d39c'; x.fillRect(0, 0, w, h); speckle(x, w, h, 260, ['#d6c084', '#f2e2b4', '#c9b077'], 1, 3); })),
  rock: () => once('rock', () => tex(256, 256, (x, w, h) => {
    x.fillStyle = '#b08d62'; x.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += rr(14, 26)) { x.fillStyle = ['#a07f56', '#c09c6c', '#9a7a52'][Math.floor(rr(0, 3))]; x.fillRect(0, y, w, rr(6, 14)); }
    speckle(x, w, h, 140, ['#8e6f49', '#c7a67a', '#7d6040'], 2, 8, 0.6);
    x.strokeStyle = '#6e5236'; x.lineWidth = 2; x.globalAlpha = 0.6;
    for (let i = 0; i < 14; i++) { x.beginPath(); let px = rr(0, w), py = rr(0, h); x.moveTo(px, py); for (let k = 0; k < 4; k++) { px += rr(-14, 14); py += rr(6, 16); x.lineTo(px, py); } x.stroke(); }
    x.globalAlpha = 1;
  })),
  stone: () => once('stone', () => tex(128, 64, (x, w, h) => {          // pond rim: rounded cobbles
    x.fillStyle = '#9c917c'; x.fillRect(0, 0, w, h);
    for (let r = 0; r < 2; r++) for (let i = 0; i < 6; i++) { x.fillStyle = ['#d8ceb4', '#c9bea2', '#e4dcc6'][(i + r) % 3]; x.beginPath(); x.ellipse(i * 22 + (r ? 11 : 0) + 4, r * 32 + 16, 10, 13, 0, 0, 7); x.fill(); }
  })),
  bark: () => once('bark', () => tex(64, 128, (x, w, h) => {
    x.fillStyle = '#8a6a46'; x.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) { x.fillStyle = '#6f5235'; x.fillRect(0, y, w, 4); x.fillStyle = '#a07e57'; x.fillRect(0, y + 5, w, 3); }
  })),
  leaves: () => once('leaves', () => tex(128, 128, (x, w, h) => { x.fillStyle = '#3f9e45'; x.fillRect(0, 0, w, h); speckle(x, w, h, 160, ['#2f8a38', '#5cc062', '#48ad4e', '#78d27a'], 4, 11); })),
  water: () => once('water', () => tex(128, 128, (x, w, h) => {
    x.fillStyle = '#3aa3e6'; x.fillRect(0, 0, w, h); speckle(x, w, h, 40, ['#5bbcf2', '#2e8fd6'], 8, 20, 0.6);
    x.strokeStyle = '#d8f3ff'; x.lineWidth = 2; x.globalAlpha = 0.8;
    for (let i = 0; i < 18; i++) { const px = rr(0, w), py = rr(0, h); x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + 6, py - 3, px + 12, py); x.stroke(); }
    x.globalAlpha = 1;
  })),
  fall: () => once('fall', () => tex(64, 128, (x, w, h) => {
    x.fillStyle = '#9fdcff'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) { x.fillStyle = ['#ffffff', '#d6f1ff'][i % 2]; x.globalAlpha = rr(0.5, 1); x.fillRect(rr(0, w), rr(0, h), rr(2, 5), rr(12, 34)); }
    x.globalAlpha = 1;
  })),
  frond: () => once('frond', () => tex(128, 256, (x, w, h) => {      // palm leaf card with see-through gaps between leaflets
    x.clearRect(0, 0, w, h);
    for (let y = 10; y < h - 6; y += 7) {
      const t = y / h, l = Math.sin(Math.min(1, t * 1.15) * Math.PI) * w * 0.47 + 6;
      x.fillStyle = ['#2f9a3e', '#3fb04c', '#36a545'][(y / 7 | 0) % 3];
      for (const sgn of [-1, 1]) { x.beginPath(); x.moveTo(w / 2, y - 2); x.quadraticCurveTo(w / 2 + sgn * l * 0.6, y + 2, w / 2 + sgn * l, y + 14); x.lineTo(w / 2 + sgn * (l - 8), y + 15); x.quadraticCurveTo(w / 2 + sgn * l * 0.4, y + 8, w / 2, y + 5); x.fill(); }
    }
    x.strokeStyle = '#7a8a3a'; x.lineWidth = 4; x.beginPath(); x.moveTo(w / 2, 2); x.lineTo(w / 2, h - 2); x.stroke();
  }, false)),
  tartan: () => once('tartan', () => tex(256, 64, (x, w, h) => {      // running track
    x.fillStyle = '#c8553d'; x.fillRect(0, 0, w, h); speckle(x, w, h, 500, ['#b84a34', '#d6664c', '#a94430'], 1, 2.5);
  })),
  blob: () => once('blob', () => tex(64, 64, (x, w) => { const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(0,0,0,.42)'); g.addColorStop(0.6, 'rgba(0,0,0,.2)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, w); }, false)),
  flower: (petal) => once('flower' + petal, () => tex(64, 64, (x) => {
    x.clearRect(0, 0, 64, 64); x.fillStyle = '#2f9a3e'; x.fillRect(30, 30, 4, 34);
    x.fillStyle = petal; for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; x.beginPath(); x.ellipse(32 + Math.cos(a) * 9, 22 + Math.sin(a) * 9, 7, 9, a, 0, 7); x.fill(); }
    x.fillStyle = '#ffd23f'; x.beginPath(); x.arc(32, 22, 5, 0, 7); x.fill();
  }, false)),
};

/* ---------- materials (vertex lit, like the era) ---------- */
export const lam = (o = {}) => new THREE.MeshLambertMaterial(o);
export function texMat(t, rx = 1, ry = 1, o = {}) { const m = t.clone(); m.needsUpdate = true; m.repeat.set(rx, ry); return lam({ map: m, ...o }); }

/* ---------- sky dome with painted clouds ---------- */
export const SKIES = {
  day:   { top: '#3f8fe8', mid: '#86c3f5', low: '#d9f0ff', fog: '#cbe7fb', hemi: ['#f2f9ff', '#8cc86a', 1.6], sun: ['#fff4d6', 1.9], cloud: '#ffffff', sunDisc: '#fff6c8', dir: [0.4, 0.8, 0.45] },
  dawn:  { top: '#6b8fd6', mid: '#f3b8a2', low: '#ffe2c4', fog: '#f7d8c6', hemi: ['#ffe2cf', '#7cb85f', 1.35], sun: ['#ffcfa0', 1.6], cloud: '#ffe6dc', sunDisc: '#ffd59a', dir: [-0.7, 0.35, -0.5] },
  dusk:  { top: '#4b5bb8', mid: '#e98d7a', low: '#ffbf8a', fog: '#e9a98e', hemi: ['#ffc09c', '#5f9452', 1.2], sun: ['#ffae78', 1.5], cloud: '#ffd2be', sunDisc: '#ffc27a', dir: [0.7, 0.3, -0.5] },
  night: { top: '#0f1840', mid: '#24336e', low: '#3f548f', fog: '#2c3d70', hemi: ['#8fa6e6', '#2a4a36', 0.8], sun: ['#b8c8ff', 0.7], cloud: '#5a6aa0', sunDisc: '#f4f1d8', dir: [-0.3, 0.8, 0.3], stars: true },
};
export function skyDome(k) {
  const t = tex(1024, 256, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, k.top); g.addColorStop(0.55, k.mid); g.addColorStop(0.92, k.low); g.addColorStop(1, k.low);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    if (k.stars) { x.fillStyle = '#ffffff'; for (let i = 0; i < 260; i++) { x.globalAlpha = rr(0.3, 1); x.fillRect(rr(0, w), rr(0, h * 0.75), rr(1, 2), rr(1, 2)); } x.globalAlpha = 1; }
    // painted cumulus: soft stacked blobs along the horizon band
    for (let c = 0; c < 14; c++) {
      const cx = rr(0, w), cy = rr(h * 0.6, h * 0.84), s = rr(12, 26);
      for (let b = 0; b < 7; b++) {
        const bx = cx + rr(-2.2, 2.2) * s, by = cy - rr(0, 1) * s * 0.7, r = s * rr(0.5, 1);
        const gr = x.createRadialGradient(bx, by - r * 0.3, r * 0.1, bx, by, r);
        const cc = k.cloud.replace('#', ''), rgb = [0, 2, 4].map(i => parseInt(cc.slice(i, i + 2), 16)).join(',');
        gr.addColorStop(0, k.cloud); gr.addColorStop(0.7, k.cloud); gr.addColorStop(1, `rgba(${rgb},0)`);   // fade to the same colour: no rings
        x.globalAlpha = k.stars ? 0.16 : 0.92; x.fillStyle = gr; x.beginPath(); x.arc(bx, by, r, 0, 7); x.fill();
      }
    }
    x.globalAlpha = 1;
  });
  t.wrapS = THREE.RepeatWrapping;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.62),
    new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -10;   // the texture spans the dome; its bottom edge sits a little below the horizon
  return dome;
}
export function lights(scene) {
  const hemi = new THREE.HemisphereLight('#ffffff', '#6aa84f', 1.1);
  const sun = new THREE.DirectionalLight('#ffffff', 1.5);
  scene.add(hemi, sun, sun.target);
  return { hemi, sun };
}
export function applySky(scene, L, k, old) {
  if (old) { scene.remove(old); old.material.map.dispose(); old.geometry.dispose(); old.material.dispose(); }
  const dome = skyDome(k); scene.add(dome);
  scene.background = new THREE.Color(k.low);
  scene.fog = new THREE.Fog(k.fog, 9, 34);
  L.hemi.color.set(k.hemi[0]); L.hemi.groundColor.set(k.hemi[1]); L.hemi.intensity = k.hemi[2];
  L.sun.color.set(k.sun[0]); L.sun.intensity = k.sun[1]; L.sun.position.set(...k.dir).multiplyScalar(10);
  return dome;
}

/* ---------- props ---------- */
export function blobShadow(w, d = w) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: TEX.blob(), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 1; return m;
}
export function palm(h = 1.7, lean = 0.08) {
  const g = new THREE.Group();
  const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * h, 0.35 * h, 0), new THREE.Vector3(lean * 0.8 * h, 0.7 * h, 0), new THREE.Vector3(-0.04 * h, h, 0));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.045 * h, 7), texMat(TEX.bark(), 1, 6)));
  const top = curve.getPoint(1);
  const fm = lam({ map: TEX.frond(), side: THREE.DoubleSide, alphaTest: 0.5 });
  for (let k = 0; k < 7; k++) {
    const a = k / 7 * Math.PI * 2 + 0.3, len = 0.7 * h;
    const geo = new THREE.PlaneGeometry(0.42 * h, len, 1, 5);
    // bend the card down along its length
    const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const v = (p.getY(i) + len / 2) / len; p.setZ(i, -v * v * 0.45 * h); }
    geo.translate(0, len / 2, 0); geo.rotateX(-Math.PI / 2 + 0.35); geo.computeVertexNormals();
    const leaf = new THREE.Mesh(geo, fm); leaf.position.copy(top); leaf.rotation.y = a; g.add(leaf);
  }
  for (const [dx, c] of [[-0.05, '#e0b33a'], [0.05, '#c98a2e'], [0, '#d9a033']]) { const n = new THREE.Mesh(new THREE.SphereGeometry(0.055 * h, 8, 6), lam({ color: c })); n.position.set(top.x + dx * h, top.y - 0.06 * h, dx * h * 0.6 + 0.03 * h); g.add(n); }
  g.add(blobShadow(0.9 * h, 0.9 * h));
  return g;
}
export function tree(s = 1, fruit = true) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.09 * s, 0.65 * s, 7), texMat(TEX.bark(), 1, 2)); trunk.position.y = 0.32 * s; g.add(trunk);
  const lm = texMat(TEX.leaves(), 2, 2);
  for (const [dx, y, r] of [[0, 0.82, 0.36], [-0.2, 0.66, 0.24], [0.22, 0.68, 0.25], [0.04, 1.02, 0.22]]) { const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1), lm); b.position.set(dx * s, y * s, 0); b.rotation.set(rr(0, 3), rr(0, 3), 0); g.add(b); }
  if (fruit) for (const [dx, y, c] of [[-0.14, 0.86, '#ff5a5a'], [0.16, 0.95, '#ffd23f'], [0.08, 0.62, '#ff5a5a'], [-0.24, 0.6, '#ff8a3d']]) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.055 * s, 8, 6), lam({ color: c, emissive: c, emissiveIntensity: 0.15 })); f.position.set(dx * s, y * s, 0.3 * s); g.add(f); }
  g.add(blobShadow(1.1 * s));
  return g;
}
export function pine(s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * s, 0.07 * s, 0.4 * s, 6), texMat(TEX.bark(), 1, 1)); trunk.position.y = 0.2 * s; g.add(trunk);
  const lm = texMat(TEX.leaves(), 2, 2, { color: '#cfe8c8' });
  for (const [y, r, h] of [[0.5, 0.42, 0.6], [0.85, 0.32, 0.5], [1.15, 0.2, 0.4]]) { const c = new THREE.Mesh(new THREE.ConeGeometry(r * s, h * s, 7), lm); c.position.y = y * s; g.add(c); }
  g.add(blobShadow(0.9 * s));
  return g;
}
export function rock(s = 1) {
  const geo = new THREE.IcosahedronGeometry(0.5 * s, 1);
  const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const k = 0.8 + 0.35 * Math.abs(Math.sin(p.getX(i) * 9 + p.getZ(i) * 7)); p.setXYZ(i, p.getX(i) * k, Math.max(-0.1, p.getY(i)) * k * 0.8, p.getZ(i) * k); }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, texMat(TEX.rock(), 1, 1));
}
export function flower(petal, s = 1) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flower(petal), alphaTest: 0.5 }));
  sp.scale.set(0.28 * s, 0.28 * s, 1); sp.center.set(0.5, 0); return sp;
}
export function grassTuft(s = 1) {
  const g = new THREE.Group(), m = lam({ color: '#3e9a30' });
  for (let k = 0; k < 5; k++) { const c = new THREE.Mesh(new THREE.ConeGeometry(0.035 * s, rr(0.18, 0.32) * s, 4), m); c.position.set(rr(-0.1, 0.1) * s, 0.1 * s, rr(-0.06, 0.06) * s); c.rotation.z = rr(-0.4, 0.4); g.add(c); }
  return g;
}
// rolling ground: flat where things happen, rising into soft hills further out
export function terrain(w, d, flat, cx = 0, cz = 0, seg = 64) {
  const geo = new THREE.PlaneGeometry(w, d, seg, seg); geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, col = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + cx, z = p.getZ(i) + cz;
    const dist = flat(x, z);
    const n = Math.sin(x * 0.55) * Math.cos(z * 0.43) + 0.6 * Math.sin(x * 1.3 + 1) * Math.sin(z * 1.1 + 2) + 0.4;
    const y = dist > 0 ? Math.min(1, dist / 4) ** 1.6 * (1.2 + n * 0.9) : 0;
    p.setY(i, y);
    const shade = 0.82 + Math.min(0.18, y * 0.08) + n * 0.03; col.push(shade, shade, shade);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const t = TEX.grass().clone(); t.needsUpdate = true; t.repeat.set(w / 1.2, d / 1.2);
  const m = new THREE.Mesh(geo, lam({ map: t, vertexColors: true }));
  m.position.set(cx, 0, cz); return m;
}
export { THREE };
