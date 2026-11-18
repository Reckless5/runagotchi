/* Runagotchi 3D garden (My pet screen).
   Same layout as tools/blender/make_garden.py: 1 unit = 1 m = 100 px of the old flat garden.
   three.js axes: x right, y up, z towards the camera (far away = negative z).
   The placeholders are built here; later they can be swapped for the artist's .glb models. */
import { THREE, buildPet } from './pet3d.js';

const W = 2.8, PERSP = 4.2, EYE = 0.42 * W;
const at = (xPct, zPx) => [(xPct - 50) / 100 * W, zPx / 100];
const C = s => new THREE.Color(s);
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color: C(color), roughness: 0.85, metalness: 0, ...o });

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; Object.assign(t, opts); return t;
}
const ell = (r, sx, sy, sz, m, seg = 24) => { const o = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg / 2), m); o.scale.set(sx, sy, sz); return o; };
const shadows = o => { o.traverse(x => { if (x.isMesh) { x.castShadow = true; x.receiveShadow = true; } }); return o; };

const SKY = {
  day:   { top: '#7fcaff', bottom: '#dff5ff', fog: '#cfeeff', hemi: ['#e8f6ff', '#9ad67e', 1.9], sun: ['#fff6dc', 2.6], sunPos: [3, 6, 2], disc: '#fff3a6', stars: false },
  dawn:  { top: '#9ccaf0', bottom: '#ffe2c4', fog: '#ffe7d2', hemi: ['#ffe6d0', '#7cc862', 1.05], sun: ['#ffd9b0', 1.8], sunPos: [-4, 2.5, -3], disc: '#ffd59a', stars: false },
  dusk:  { top: '#6d7fd6', bottom: '#ffb48a', fog: '#f5b494', hemi: ['#ffc2a0', '#5f9a52', 0.95], sun: ['#ffb27a', 1.5], sunPos: [4, 1.8, -3], disc: '#ffcf7a', stars: false },
  night: { top: '#1c2a5c', bottom: '#4a5f9c', fog: '#3a4d84', hemi: ['#8fa6e6', '#2d4a35', 0.55], sun: ['#b8c8ff', 0.7], sunPos: [-2, 5, 1], disc: '#f4f1d8', stars: true },
};

function buildWorld(scene) {
  const world = new THREE.Group(); scene.add(world);
  // ground with mowed stripes (0.26 m wide), 16.8 × 26 m
  const stripes = canvasTex(64, 4, (x, w, h) => { x.fillStyle = '#7dd05f'; x.fillRect(0, 0, w, h); x.fillStyle = '#72c656'; x.fillRect(w / 2, 0, w / 2, h); },
    { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: 4 });
  stripes.repeat.set(6 * W / 0.52, 1);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6 * W, 26), new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; ground.position.z = -9; ground.receiveShadow = true; world.add(ground);
  // pond
  const pond = new THREE.Group(); pond.position.set(0.36 * W, 0, -1.65); world.add(pond);
  const rim = new THREE.Mesh(new THREE.CircleGeometry(0.5, 48), std('#d9cba4')); rim.rotation.x = -Math.PI / 2; rim.scale.set(0.67 / 0.82, 1.1 / 0.86, 1); rim.position.y = 0.006; rim.receiveShadow = true;
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.5, 48), std('#58b8f0', { roughness: 0.15 })); water.rotation.x = -Math.PI / 2; water.scale.set(0.67, 1.1, 1); water.position.y = 0.012;
  pond.add(rim, water);
  // path
  const path = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 5.2), std('#e3d3a3')); path.rotation.x = -Math.PI / 2; path.position.set(0, 0.004, -2.4); path.receiveShadow = true; world.add(path);
  // hills
  for (const [z, color, h] of [[-11.6, '#9ad67e', 1.25], [-11.0, '#7cc862', 0.8]]) {
    const m = std(color);
    for (let i = 0; i < 18; i++) {
      const x = -28 + i * (56 / 17) + (z > -11.3 ? 1.6 : 0), sx = 2.4 + (i * 37 % 7) * 0.25;
      const hill = ell(1, sx, h + (i * 13 % 5) * 0.08, 1.2, m); hill.position.set(x, 0, z); world.add(hill);
    }
  }
  // cliff with waterfall (x 30 %, z −700)
  const [cx, cz] = at(30, -700);
  const cliff = new THREE.Mesh(new THREE.RoundedBoxGeometry(1.5, 2.5, 0.9, 4, 0.25), std('#b99a6b')); cliff.position.set(cx, 1.25, cz);
  const moss = ell(1, 0.85, 0.2, 0.55, std('#6dbb52')); moss.position.set(cx, 2.5, cz);
  const fallTex = canvasTex(16, 64, (x, w, h) => { x.fillStyle = '#bfe9ff'; x.fillRect(0, 0, w, h); x.fillStyle = '#ffffff'; for (let i = 0; i < 4; i++) x.fillRect(3 + i * 3 % 10, i * 16, 2, 8); },
    { wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
  fallTex.repeat.set(1, 3);
  const fall = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 2.3), new THREE.MeshBasicMaterial({ map: fallTex })); fall.position.set(cx + 0.1, 1.25, cz + 0.46);
  world.add(shadows(cliff), moss, fall);
  // palms, tree, flowers
  const palm = (xPct, zPx, h) => {
    const [x, z] = at(xPct, zPx), g = new THREE.Group(); g.position.set(x, 0, z);
    const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.08 * h, 0.4 * h, 0), new THREE.Vector3(0.06 * h, 0.7 * h, 0), new THREE.Vector3(-0.05 * h, h, 0));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.035 * h, 8), std('#8a6a46')));
    const leaf = std('#36a14a');
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2, l = ell(1, 0.32 * h, 0.03 * h, 0.07 * h, leaf, 16);
      l.position.set(-0.05 * h + Math.cos(a) * 0.26 * h, 0.95 * h, Math.sin(a) * 0.26 * h); l.rotation.set(0, -a, -0.35); g.add(l);
    }
    for (const [dx, c] of [[-0.04, '#ffcf3f'], [0.04, '#ff8a3d']]) { const n = ell(0.05 * h, 1, 1, 1, std(c), 12); n.position.set(-0.05 * h + dx * h, 0.92 * h, 0.04 * h); g.add(n); }
    world.add(shadows(g));
  };
  palm(4, -140, 1.7); palm(75, -560, 0.67);
  {
    const [x, z] = at(92, -230), g = new THREE.Group(); g.position.set(x, 0, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 12), std('#8a6a46')); trunk.position.y = 0.3; g.add(trunk);
    for (const [dx, y, r, c] of [[0, 0.78, 0.34, '#4fb35b'], [-0.18, 0.62, 0.22, '#45a852'], [0.2, 0.64, 0.22, '#5cc067']]) { const b = ell(r, 1, 1, 1, std(c)); b.position.set(dx, y, 0); g.add(b); }
    for (const [dx, y, c] of [[-0.12, 0.84, '#ff6b6b'], [0.14, 0.92, '#ffd23f'], [0.06, 0.6, '#ff6b6b']]) { const f = ell(0.06, 1, 1, 1, std(c), 12); f.position.set(dx, y, 0.3); g.add(f); }
    world.add(shadows(g));
  }
  const tuft = (xPct, zPx, flower) => {
    const [x, z] = at(xPct, zPx), g = new THREE.Group(); g.position.set(x, 0, z);
    const m = std('#2f9a3e');
    for (const [dx, h] of [[-0.12, 0.35], [0, 0.5], [0.12, 0.3]]) { const c = new THREE.Mesh(new THREE.ConeGeometry(0.06, h, 8), m); c.position.set(dx, h / 2, 0); c.rotation.z = -dx * 1.6; g.add(c); }
    const p = ell(0.06, 1, 0.35, 1, std(flower), 12); p.position.set(-0.1, 0.32, 0.05); p.rotation.x = 1.2;
    const cc = ell(0.025, 1, 1, 1, std('#ffe36b'), 8); cc.position.set(-0.1, 0.33, 0.07);
    g.add(p, cc); world.add(shadows(g));
  };
  tuft(4, 70, '#ff7eb6'); tuft(97, 90, '#ffffff');
  // sun / moon and clouds
  const [sx, sz] = at(68, -1100);
  const disc = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 12), new THREE.MeshBasicMaterial({ color: '#fff3a6', fog: false })); disc.position.set(sx, 3.3, sz); world.add(disc);
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35, transparent: true, opacity: 1 });
  for (const [xp, zp, top, w] of [[30, -1000, 3.2, 1.1], [88, -800, 2.5, 0.85]]) {
    const [x, z] = at(xp, zp), g = new THREE.Group(); g.position.set(x, top, z);
    for (const [dx, dy, r, a, b] of [[0, 0, 0.42, 0.2, 0.15], [0.15, 0.1, 0.25, 0.17, 0.18], [-0.2, 0.04, 0.18, 0.13, 0.15]]) { const e = ell(1, r * w, b * w, a * w, cloudMat, 16); e.position.set(dx * w, dy * w, 0); g.add(e); }
    world.add(g);
  }
  // stars (night only)
  const sp = []; for (let i = 0; i < 160; i++) { const a = Math.random() * Math.PI - Math.PI / 2 - Math.PI / 2, e = 0.15 + Math.random() * 1.2; sp.push(Math.cos(a) * 30 * Math.cos(e), 30 * Math.sin(e), Math.sin(a) * 30 * Math.cos(e)); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 0.08, fog: false })); world.add(stars);
  return { fallTex, disc, stars, cloudMat };
}

export function createGarden() {
  let R = null, scene, cam, hemi, sun, parts, pet = null, petKey = '', tod = '', container = null;
  let view = { x: 0, z: 0 }, heading = 0, size = 0;
  const g = {
    active: false,
    ok: true,
    attach(el, spec) {
      if (!R) {
        try {
          R = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
        } catch (e) { g.ok = false; return false; }
        R.outputColorSpace = THREE.SRGBColorSpace;
        R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
        R.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        R.domElement.className = 'g3d-canvas';
        scene = new THREE.Scene();
        cam = new THREE.PerspectiveCamera(2 * Math.atan(W / 2 / PERSP) * 180 / Math.PI, 1, 0.05, 80);
        hemi = new THREE.HemisphereLight('#ffffff', '#7cc862', 1.2); scene.add(hemi);
        sun = new THREE.DirectionalLight('#ffffff', 2.2); sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 30 });
        sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.02;
        scene.add(sun, sun.target);
        parts = buildWorld(scene);
      }
      container = el; g.active = true;
      if (R.domElement.parentNode !== el) el.prepend(R.domElement);
      g.resize();
      if (spec.tod !== tod) g.setTime(spec.tod);
      const key = JSON.stringify([spec.pet, spec.mood, spec.stage]);
      if (key !== petKey) {
        if (pet) { scene.remove(pet); pet.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
        pet = buildPet(spec.pet, spec.mood, spec.stage); pet.traverse(o => { if (o.isMesh) o.castShadow = true; });
        scene.add(pet); petKey = key;
      }
      return true;
    },
    detach() { g.active = false; container = null; },
    resize() {
      if (!container) return;
      const s = Math.max(1, Math.round(container.clientWidth));
      if (s !== size) { size = s; R.setSize(s, s, false); R.domElement.style.width = R.domElement.style.height = '100%'; }
    },
    setTime(t) {
      tod = t; const k = SKY[t] || SKY.day;
      scene.background = canvasTex(2, 256, (x, w, h) => { const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, k.top); gr.addColorStop(0.62, k.bottom); gr.addColorStop(1, k.bottom); x.fillStyle = gr; x.fillRect(0, 0, w, h); });
      scene.fog = new THREE.Fog(k.fog, 12, 36);
      hemi.color.set(k.hemi[0]); hemi.groundColor.set(k.hemi[1]); hemi.intensity = k.hemi[2];
      sun.color.set(k.sun[0]); sun.intensity = k.sun[1]; sun.userData.dir = new THREE.Vector3(...k.sunPos).normalize();
      parts.disc.material.color.set(k.disc); parts.stars.visible = k.stars;
      parts.cloudMat.opacity = k.stars ? 0.3 : 1;
    },
    /* tilt: {x, y} −1…1 · p: {x, z} pet position in old px units, y: hop (px, negative = up), heading (rad), state */
    frame(t, tilt, p) {
      if (!g.active || !container || !container.isConnected) { g.active = false; return null; }
      g.resize();
      const px = p.x / 100, pz = p.z / 100;
      // the pet
      if (pet) {
        pet.position.set(px, -p.y / 100, pz);
        let d = p.heading - heading; d = Math.atan2(Math.sin(d), Math.cos(d)); heading += d * 0.12;
        pet.rotation.y = heading;
        const ud = pet.userData, s = p.state, now = t / 1000;
        const walk = s === 'walk', step = walk ? Math.sin(now * (p.slow ? 5 : 9)) : 0;
        ud.feet[0].position.z = ud.feet[0].userData.z0 + step * 0.09; ud.feet[1].position.z = ud.feet[1].userData.z0 - step * 0.09;
        ud.inner.position.y = walk ? Math.abs(step) * 0.03 : 0;
        ud.inner.rotation.x = s === 'drink' || s === 'eat' ? (Math.sin(now * 6) > 0.3 ? 0.35 : 0.15) : walk ? 0.06 : 0;
        const rest = s === 'sit' || s === 'sleep';
        ud.inner.scale.y += ((rest ? 0.9 : 1) - ud.inner.scale.y) * 0.1;
        if (s === 'sleep') ud.inner.rotation.z = Math.sin(now * 1.2) * 0.04; else ud.inner.rotation.z = 0;
      }
      // camera: locked on the pet, orbiting with the tilt
      view.x += (px - view.x) * 0.08; view.z += (pz - view.z) * 0.08;
      const yaw = tilt.x * 11 * Math.PI / 180, pitch = tilt.y * 6 * Math.PI / 180;
      const off = new THREE.Vector3(0, EYE, PERSP).applyAxisAngle(new THREE.Vector3(1, 0, 0), -pitch).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      cam.position.set(view.x + off.x, off.y, view.z + off.z);
      const look = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(1, 0, 0), -pitch).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      cam.lookAt(cam.position.clone().add(look));
      // sun shadow follows the pet
      const sd = sun.userData.dir || new THREE.Vector3(0.4, 0.8, 0.3);
      sun.target.position.set(view.x, 0, view.z); sun.position.set(view.x + sd.x * 10, sd.y * 10, view.z + sd.z * 10);
      parts.fallTex.offset.y = (t / 1000 * 0.9) % 1;
      R.render(scene, cam);
      // where the pet's head is on screen, for the speech bubble (0…1)
      if (!pet) return null;
      const head = new THREE.Vector3(px, pet.userData.height - p.y / 100 + 0.12, pz).project(cam);
      return { x: (head.x + 1) / 2, y: (1 - head.y) / 2 };
    },
  };
  return g;
}
