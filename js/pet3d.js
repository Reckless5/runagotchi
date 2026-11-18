/* Runagotchi 3D pet.
   The pet is built from one base shape (box, sphere, capsule, pyramid, donut) plus face, feet,
   pattern and accessory. Face, pattern and accessories are placed on the body's surface with
   ray casts, so they fit any shape (and any future shape or model).
   Units: metres. The pet's origin is on the ground between its feet; it faces +z. */
import * as THREE from '../vendor/three.js';

export const SHAPES3D = {
  sphere:  { label: 'Sphere' },
  box:     { label: 'Box' },
  capsule: { label: 'Capsule' },
  pyramid: { label: 'Pyramid' },
  donut:   { label: 'Donut' },
};
// Pets made before the 3D update keep a matching look.
const OLD_TO_NEW = { blob: 'sphere', bean: 'capsule', pebble: 'box', drop: 'pyramid' };
export const shapeOf = s => (SHAPES3D[s] ? s : OLD_TO_NEW[s] || 'sphere');

const FOOT_H = 0.1;   // body starts this high above the ground
// per shape: where the eyes go (height, half distance) and the headband height
const LAYOUT = {
  sphere:  { eyeY: 0.70, eyeX: 0.17, bandY: 0.96, footX: 0.24, footZ: 0.12 },
  box:     { eyeY: 0.70, eyeX: 0.18, bandY: 0.90, footX: 0.26, footZ: 0.30 },
  capsule: { eyeY: 0.86, eyeX: 0.15, bandY: 1.08, footX: 0.2,  footZ: 0.12 },
  pyramid: { eyeY: 0.52, eyeX: 0.13, bandY: 0.74, footX: 0.24, footZ: 0.40 },
  donut:   { eyeY: 0.40, eyeX: 0.16, bandY: 0.54, footX: 0.3,  footZ: 0.50 },
};

function bodyGeometry(shape) {
  let g;
  switch (shape) {
    case 'box':
      g = new THREE.RoundedBoxGeometry(0.98, 0.92, 0.84, 5, 0.2); g.translate(0, 0.46, 0); break;
    case 'capsule':
      g = new THREE.CapsuleGeometry(0.4, 0.44, 12, 32); g.translate(0, 0.62, 0); break;
    case 'pyramid':
      g = new THREE.ConeGeometry(0.66, 1.12, 4, 1); g.rotateY(Math.PI / 4); g.translate(0, 0.56, 0); break;
    case 'donut':
      g = new THREE.TorusGeometry(0.4, 0.28, 24, 56); g.rotateX(Math.PI / 2); g.scale(1, 1.15, 1); g.translate(0, 0.322, 0); break;
    default:
      g = new THREE.SphereGeometry(0.56, 48, 32); g.scale(1, 0.95, 0.95); g.translate(0, 0.532, 0);
  }
  g.translate(0, FOOT_H, 0);
  g.computeVertexNormals();
  return g;
}

const hex = h => new THREE.Color(h);
function mix(a, b, t) { return hex(a).lerp(hex(b), t); }
function shade(c, t) { const x = hex(c); return t < 0 ? x.multiplyScalar(1 + t) : x.lerp(new THREE.Color('#ffffff'), t); }
const MATS = new Map();
function mat(color, opts = {}) {
  const c = color instanceof THREE.Color ? color : hex(color);
  const key = c.getHexString() + JSON.stringify(opts);
  if (!MATS.has(key)) MATS.set(key, new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0, ...opts }));
  return MATS.get(key);
}
const INK = '#2b2a22';

// find the body surface along a ray (in the pet's own space)
const ray = new THREE.Raycaster();
function hit(body, from, dir) {
  ray.set(from, dir.clone().normalize());
  const h = ray.intersectObject(body, false)[0];
  if (!h) return null;
  const n = h.face.normal.clone().transformDirection(body.matrixWorld).normalize();
  return { p: h.point.clone(), n };
}
function frontHit(body, x, y) { return hit(body, new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1)); }
function topHit(body) {
  return hit(body, new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0))
    || hit(body, new THREE.Vector3(0, 5, 0.4), new THREE.Vector3(0, -1, 0));      // donut: the hole is in the middle
}
// put an object on the surface, facing out
function stick(obj, h, out = 0.005) {
  obj.position.copy(h.p).addScaledVector(h.n, out);
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), h.n);
  return obj;
}
function ellipsoid(r, sx, sy, sz, material, seg = 20) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg / 2)), material);
  m.scale.set(sx, sy, sz); return m;
}
function arc(radius, tube, material, start = 0, len = Math.PI) {
  const g = new THREE.TorusGeometry(radius, tube, 8, 24, len); g.rotateZ(start);
  return new THREE.Mesh(g, material);
}

/* p: { shape, color (hex), pattern, acc, condition }  mood: happy|content|hungry|starving|dead  stage: baby|kid|grown */
export function buildPet(p, mood = 'content', stage = 'grown') {
  const shape = shapeOf(p.shape), L = LAYOUT[shape];
  const dead = mood === 'dead';
  const cond = dead ? null : (p.condition || null);
  const base = p.color || '#ff8a50';
  const col = dead ? hex('#d6d6d0') : cond === 'sick' ? mix(base, '#b5d68a', 0.45) : hex(base);
  const dark = shade(col, -0.35);
  const root = new THREE.Group(); root.name = 'pet';
  const inner = new THREE.Group(); root.add(inner);           // bobbing / squashing happens on inner
  const body = new THREE.Mesh(bodyGeometry(shape), mat(col, { flatShading: shape === 'pyramid' }));
  body.name = 'body'; body.castShadow = true;
  inner.add(body);
  inner.updateMatrixWorld(true);

  // feet
  const feet = [-1, 1].map(s => {
    const f = ellipsoid(0.13, 1, 0.55, 1.3, mat(dark));
    f.position.set(s * L.footX, 0.07, L.footZ); f.castShadow = true; f.userData.z0 = L.footZ;
    root.add(f); return f;
  });

  // pattern
  if (p.pattern === 'spots') {
    const spotMat = mat(shade(col, -0.32));
    const dirs = [[0.75, 0.45, 0.6], [-0.8, 0.1, 0.55], [0.35, 1, 0.1], [-0.6, 0.8, -0.3], [0.9, -0.3, -0.2], [-0.4, -0.5, 0.75], [0.1, 0.3, -1]];
    for (const [x, y, z] of dirs) {
      const d = new THREE.Vector3(x, y * 0.6, z).normalize();
      const from = new THREE.Vector3(0, L.bandY * 0.7, 0).addScaledVector(d, 5);
      const h = hit(body, from, d.clone().negate()); if (!h || Math.abs(h.p.x) < 0.3 && h.n.z > 0.7 && Math.abs(h.p.y - L.eyeY) < 0.22) continue; // keep the face clear
      inner.add(stick(ellipsoid(0.09, 1, 1, 0.25, spotMat, 16), h, 0.004));
    }
  } else if (p.pattern === 'belly') {
    const h = frontHit(body, 0, Math.max(FOOT_H + 0.22, L.eyeY - 0.34));
    if (h) inner.add(stick(ellipsoid(0.27, 1, 0.8, 0.12, mat(shade(col, 0.5)), 24), h, 0.0));
  }

  // face
  const ink = mat(INK, { roughness: 0.3 });
  const eyes = [-1, 1].map(s => frontHit(body, s * L.eyeX, L.eyeY));
  const mouthAt = frontHit(body, 0, L.eyeY - 0.14);
  const face = new THREE.Group(); inner.add(face);
  const eyeKind = dead ? 'x' : mood === 'happy' && !cond ? 'arc' : cond === 'sick' ? 'sleepy' : 'dot';
  eyes.forEach((h, i) => {
    if (!h) return;
    const g = new THREE.Group(); stick(g, h, 0.01); face.add(g);
    if (eyeKind === 'x') {
      for (const r of [0.8, -0.8]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.02), ink); b.rotation.z = r; g.add(b); }
    } else if (eyeKind === 'arc') {
      g.add(arc(0.055, 0.016, ink));
    } else {
      const e = ellipsoid(0.06, 1, eyeKind === 'sleepy' ? 0.45 : 1.25, 0.45, ink, 20); g.add(e);
      if (eyeKind === 'dot') { const s = ellipsoid(0.02, 1, 1, 0.5, mat('#ffffff', { roughness: 0.2 }), 10); s.position.set(0.02, 0.03, 0.03); g.add(s); }
    }
    if (mood === 'hungry' || mood === 'starving') {           // worried brows
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.022, 0.02), ink);
      b.position.set(0, 0.11, 0.005); b.rotation.z = (i ? -1 : 1) * 0.35; g.add(b);
    }
  });
  if (mouthAt) {
    const g = new THREE.Group(); stick(g, mouthAt, 0.008); face.add(g);
    if (dead) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), ink); g.add(b); }
    else if (mood === 'starving') g.add(ellipsoid(0.04, 1, 1.25, 0.4, mat('#5a2a22'), 16));
    else if (mood === 'hungry' || cond) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.02), ink); g.add(b); }
    else { const m = arc(mood === 'happy' ? 0.06 : 0.045, 0.014, ink, Math.PI); m.position.y = 0.03; g.add(m); }
  }
  if (!dead && (mood === 'happy' || cond === 'sick')) {         // cheeks
    const blush = mat(cond === 'sick' ? '#ff6a6a' : '#ff7a8a', { transparent: true, opacity: cond === 'sick' ? 0.7 : 0.5 });
    for (const s of [-1, 1]) { const h = frontHit(body, s * (L.eyeX + 0.1), L.eyeY - 0.09); if (h) face.add(stick(ellipsoid(0.05, 1.3, 0.8, 0.15, blush, 12), h, 0.004)); }
  }
  if (!dead && (mood === 'starving' || cond === 'sick')) {      // sweat drop
    const h = frontHit(body, L.eyeX + 0.16, L.eyeY + 0.12);
    if (h) { const d = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.08, 12), mat('#8fd0ff', { roughness: 0.1 })); stick(d, h, 0.03); d.rotateX(-Math.PI / 2); face.add(d); }
  }

  // ring around the body at a height (headband, bandage, …)
  const ringAt = (y, tube, material, tiltZ = 0) => {
    const pts = [];
    for (let k = 0; k < 28; k++) {
      const a = k / 28 * Math.PI * 2, d = new THREE.Vector3(Math.sin(a), Math.tan(tiltZ) * Math.sin(a), Math.cos(a));
      const h = hit(body, new THREE.Vector3(0, y, 0).addScaledVector(d, 5), d.clone().negate());
      if (h) pts.push(h.p.addScaledVector(h.n, tube * 0.6));
    }
    if (pts.length < 8) return null;
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 64, tube, 8, true), material);
    m.castShadow = true; return m;
  };

  if (cond === 'injured') {
    const band = ringAt(L.eyeY - 0.3, 0.035, mat('#fbfbf7', { roughness: 0.9 }), 0.25);
    if (band) inner.add(band);
    const h = frontHit(body, -(L.eyeX + 0.12), L.eyeY + 0.12);
    if (h) {
      const g = new THREE.Group(); stick(g, h, 0.01); g.rotateZ(0.6);
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.015), mat('#f2c89a')));
      const g2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.015), mat('#f2c89a')); g.add(g2); face.add(g);
    }
  }

  // accessory
  const acc = dead ? 'none' : (p.acc || 'none');
  const top = topHit(body);
  if (acc === 'headband') {
    const b = ringAt(L.bandY, 0.045, mat('#e8454d', { roughness: 0.7 })); if (b) inner.add(b);
  } else if (acc === 'cap' && top) {
    const g = new THREE.Group(); g.position.copy(top.p);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat('#3d7cf0')); dome.scale.y = 0.75; dome.castShadow = true;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 24, 1, false, -Math.PI / 2, Math.PI), mat('#2e63c7'));
    brim.scale.set(1, 1, 1.4); brim.position.set(0, 0.01, 0.16);
    const btn = ellipsoid(0.04, 1, 0.6, 1, mat('#ffffff')); btn.position.y = 0.2;
    g.add(dome, brim, btn); g.position.y -= 0.02; inner.add(g);
  } else if (acc === 'sprout' && top) {
    const g = new THREE.Group(); g.position.copy(top.p);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.2, 8), mat('#3f9a45')); stem.position.y = 0.1;
    const leafMat = mat('#5cc067');
    const l1 = ellipsoid(0.09, 1, 0.3, 0.55, leafMat, 16); l1.position.set(-0.08, 0.2, 0); l1.rotation.z = 0.5;
    const l2 = ellipsoid(0.09, 1, 0.3, 0.55, leafMat, 16); l2.position.set(0.08, 0.22, 0); l2.rotation.z = -0.5;
    g.add(stem, l1, l2); g.traverse(o => { o.castShadow = true; }); inner.add(g);
  } else if (acc === 'bow' && top) {
    const g = new THREE.Group();
    const h = hit(body, new THREE.Vector3(0.25, 5, 0.1), new THREE.Vector3(0, -1, 0)) || top;
    g.position.copy(h.p); g.rotation.z = -0.3;
    const bm = mat('#ff7eb6');
    for (const s of [-1, 1]) { const c = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 12), bm); c.rotation.z = s * Math.PI / 2; c.position.x = s * 0.08; g.add(c); }
    g.add(ellipsoid(0.04, 1, 1, 1, mat('#e85a9a'))); g.traverse(o => { o.castShadow = true; }); inner.add(g);
  }

  const scale = { baby: 0.72, kid: 0.86, grown: 1 }[stage] || 1;
  root.scale.setScalar(scale);
  const box = new THREE.Box3().setFromObject(body);
  root.userData = { feet, inner, body, height: box.max.y * scale, dead };
  return root;
}

/* ---------- pictures of pets for everywhere else (one shared renderer, cached) ---------- */
let TR = null;
function thumbRenderer() {
  if (TR !== null) return TR;
  try {
    const canvas = document.createElement('canvas');
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#c9b48a', 1.7));
    const sun = new THREE.DirectionalLight('#ffffff', 1.9); sun.position.set(2, 4, 3); scene.add(sun);
    const cam = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
    // soft round shadow
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.5), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002; scene.add(shadow);
    TR = { r, scene, cam, shadow };
  } catch (e) { TR = false; }
  return TR;
}
export const has3D = () => !!thumbRenderer();

const CACHE = new Map();
/* pose: 'front' | 'run0' | 'run1' (running to the right, two steps) */
export function petImage(p, mood, stage, { pose = 'front', size = 160 } = {}) {
  const T = thumbRenderer(); if (!T) return null;
  const key = [shapeOf(p.shape), p.color, p.pattern, p.acc, p.condition || '', mood, stage, pose, size].join('|');
  if (CACHE.has(key)) return CACHE.get(key);
  const pet = buildPet(p, mood, stage);
  const run = pose.startsWith('run');
  if (run) {
    pet.rotation.y = 0.75;
    const ph = pose === 'run0' ? 1 : -1;
    pet.userData.feet[0].position.z += 0.12 * ph; pet.userData.feet[1].position.z -= 0.12 * ph;
    pet.userData.feet[0].position.y += ph > 0 ? 0.04 : 0; pet.userData.feet[1].position.y += ph < 0 ? 0.04 : 0;
    pet.userData.inner.position.y = ph > 0 ? 0.04 : 0;
    pet.userData.inner.rotation.x = 0.08;
  } else pet.rotation.y = -0.3;
  if (mood === 'dead') { pet.rotation.z = 0; }
  T.scene.add(pet);
  // frame the full-grown size so pets of different stages keep their relative size
  T.cam.position.set(0, 1.25, 4.5); T.cam.lookAt(0, 0.6, 0);
  const px = Math.round(size * Math.min(1.5, window.devicePixelRatio || 1));
  T.r.setSize(px, px, false);
  T.r.render(T.scene, T.cam);
  const url = T.r.domElement.toDataURL('image/png');
  T.scene.remove(pet);
  pet.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, url);
  return url;
}
export { THREE };
