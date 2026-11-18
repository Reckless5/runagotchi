/* Runagotchi 3D Crew run, retro console style (see gc3d.js).
   Side view of a running track; the scenery streams past while the pets run on the spot.
   app.js still decides where every pet runs (left % and bottom px of the scene, like the
   flat version), so the name tags, chat bubbles and 🤝 links stay plain HTML. Each pet is
   placed where a ray from the camera through that screen spot meets the track. */
import { buildPet } from './pet3d.js';
import { THREE, renderer, TEX, lam, texMat, SKIES, applySky, lights, blobShadow, palm, tree, pine, rock, flower, grassTuft, terrain, rr } from './gc3d.js';

const SPEED = 1.3;          // m/s the world streams past
const SPAN = 22;            // scenery loops over this many metres
const FOV = 32;

function buildWorld(scene) {
  const A = { movers: [] };
  // ground behind the track rises into hills; flat strip for the track and verge
  const flat = (x, z) => -z - 3;                 // flat from z = −3 towards the camera
  scene.add(terrain(70, 46, flat, 0, -18, 64));
  // track: tartan with white edge lines
  const tt = TEX.tartan().clone(); tt.needsUpdate = true; tt.repeat.set(30 / 2, 1); A.track = tt;
  const track = new THREE.Mesh(new THREE.PlaneGeometry(30, 1.9), lam({ map: tt })); track.rotation.x = -Math.PI / 2; track.position.set(0, 0.004, 1.7); scene.add(track);
  for (const z of [0.78, 2.62]) { const l = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.05), lam({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.2 })); l.rotation.x = -Math.PI / 2; l.position.set(0, 0.008, z); scene.add(l); }
  // dashed middle line (streams with the track)
  const dt = new THREE.CanvasTexture((() => { const c = document.createElement('canvas'); c.width = 64; c.height = 4; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 32, 4); return c; })());
  dt.wrapS = THREE.RepeatWrapping; dt.repeat.set(30 / 1.2, 1); A.dash = dt;
  const dash = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.04), new THREE.MeshBasicMaterial({ map: dt, transparent: true, alphaTest: 0.5 }));
  dash.rotation.x = -Math.PI / 2; dash.position.set(0, 0.009, 1.7); scene.add(dash);
  // near verge: grass in front of the track
  const vt = TEX.grass().clone(); vt.needsUpdate = true; vt.repeat.set(25, 2); A.verge = vt;
  const verge = new THREE.Mesh(new THREE.PlaneGeometry(30, 2.4), lam({ map: vt })); verge.rotation.x = -Math.PI / 2; verge.position.set(0, 0.002, 3.8); scene.add(verge);
  const gt = TEX.grass().clone(); gt.needsUpdate = true; gt.repeat.set(25, 3); A.field = gt;
  const field = new THREE.Mesh(new THREE.PlaneGeometry(30, 3.8), lam({ map: gt })); field.rotation.x = -Math.PI / 2; field.position.set(0, 0.002, -1.1); scene.add(field);
  // scenery that streams past (wraps around)
  const add = (o, x, z, ry = rr(0, 6)) => { o.position.set(x, 0, z); o.rotation.y = ry; scene.add(o); A.movers.push(o); return o; };
  const petals = ['#ff7eb6', '#ffffff', '#ffd23f', '#8fd0ff'];
  for (let i = 0; i < 9; i++) add([() => palm(rr(1.5, 2.1)), () => tree(rr(0.9, 1.25), rand2()), () => pine(rr(1.3, 1.9))][i % 3](), -SPAN / 2 + i * SPAN / 9 + rr(-0.6, 0.6), rr(-3.2, -1.4));
  for (let i = 0; i < 7; i++) add([() => pine(rr(1.8, 2.6)), () => palm(rr(2, 2.6)), () => tree(rr(1.3, 1.6), false)][i % 3](), -SPAN / 2 + i * SPAN / 7 + rr(-1, 1), rr(-7, -4.5));
  for (let i = 0; i < 6; i++) { const r = rock(rr(0.4, 0.7)); add(r, -SPAN / 2 + i * SPAN / 6 + rr(0, 2), rr(-1.2, -0.5)); }
  for (let i = 0; i < 16; i++) { const f = flower(petals[i % 4], rr(0.8, 1.1)); add(f, -SPAN / 2 + i * SPAN / 16 + rr(0, 1), i % 2 ? rr(2.8, 3.4) : rr(-0.6, -0.2), 0); }
  for (let i = 0; i < 14; i++) add(grassTuft(rr(0.8, 1.3)), -SPAN / 2 + i * SPAN / 14 + rr(0, 1), i % 2 ? rr(2.75, 3.6) : rr(-0.7, -0.15));
  // far mountains (they barely move)
  const mm = texMat(TEX.rock(), 3, 2, { color: '#b7c4e0' });
  A.far = new THREE.Group(); scene.add(A.far);
  for (let i = 0; i < 7; i++) {
    const h = rr(5, 9), m = new THREE.Mesh(new THREE.ConeGeometry(h * 0.9, h, 6), mm); m.position.set(-24 + i * 8 + rr(-2, 2), h / 2 - 0.5, rr(-30, -26)); A.far.add(m);
    const snow = new THREE.Mesh(new THREE.ConeGeometry(h * 0.26, h * 0.29, 6), lam({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.15 })); snow.position.set(m.position.x, m.position.y + h * 0.36, m.position.z + 0.05); A.far.add(snow);
  }
  // sun / moon
  const glow = new THREE.Mesh(new THREE.CircleGeometry(2.4, 32), new THREE.MeshBasicMaterial({ map: TEX.blob(), color: '#ffffff', transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32), new THREE.MeshBasicMaterial({ color: '#fff6c8', fog: false }));
  A.sun = new THREE.Group(); A.sun.add(glow, disc); A.disc = disc; scene.add(A.sun);
  return A;
}
let r2 = 3; const rand2 = () => (r2++ % 2) === 0;

function buildCart() {
  const g = new THREE.Group();
  const wood = texMat(TEX.bark(), 2, 1, { color: '#e2b98a' });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 0.32, 0.62), wood); box.position.y = 0.36; g.add(box);
  const rimM = lam({ color: '#7a5434' });
  for (const z of [-0.31, 0.31]) { const r = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.05, 0.05), rimM); r.position.set(0, 0.53, z); g.add(r); }
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6), rimM); handle.rotation.z = Math.PI / 2 - 0.35; handle.position.set(0.78, 0.42, 0); g.add(handle);
  const wheels = [];
  for (const [x, z] of [[-0.3, 0.33], [0.3, 0.33], [-0.3, -0.33], [0.3, -0.33]]) {
    const w = new THREE.Group(); w.position.set(x, 0.17, z);
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 14), lam({ color: '#4a3424' })); tyre.rotation.x = Math.PI / 2; w.add(tyre);
    for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.07), lam({ color: '#c99a62' })); s.rotation.z = k * Math.PI / 3; w.add(s); }
    g.add(w); wheels.push(w);
  }
  g.add(blobShadow(1.4, 0.9));
  g.userData.wheels = wheels;
  return g;
}

export function createCrew() {
  let R = null, scene, cam, L, A, dome = null, tod = '', container = null, size = [0, 0], visible = true, io = null;
  const pets = new Map();        // key → { obj, shadow, spec }
  let cart = null, cartInfo = null, items = [];
  const ray = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), v2 = new THREE.Vector2(), hitP = new THREE.Vector3();
  // screen spot (left %, bottom px) → point on the ground, and metres per pixel there
  const toGround = (xPct, bottomPx) => {
    const [w, h] = size;
    v2.set(xPct / 50 - 1, (bottomPx / h) * 2 - 1);
    ray.setFromCamera(v2, cam);
    if (!ray.ray.intersectPlane(ground, hitP)) return null;
    const dist = hitP.distanceTo(cam.position);
    const mpp = 2 * dist * Math.tan(FOV * Math.PI / 360) / h;
    return { p: hitP.clone(), mpp };
  };
  const c = {
    ok: true, active: false,
    /* spec: { tod, runners: [{ key, pet, mood, stage, xPct, bottomPx, widthPx, spd, strong }], cart: { xPct, bottomPx, widthPx, parked, riders: [{ key, pet, mood, stage }] } | null } */
    attach(el, spec) {
      R = renderer();
      if (!R) { c.ok = false; return false; }
      if (!scene) {
        scene = new THREE.Scene();
        cam = new THREE.PerspectiveCamera(FOV, 1, 0.05, 120);
        L = lights(scene); A = buildWorld(scene);
      }
      container = el; c.active = true;
      if (R.domElement.parentNode !== el) {
        el.prepend(R.domElement); size = [0, 0];
        if (io) io.disconnect();
        if ('IntersectionObserver' in window) { io = new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; }); io.observe(el); }
      }
      c.resize();
      if (spec.tod !== tod) {
        tod = spec.tod; const k = SKIES[tod] || SKIES.day;
        dome = applySky(scene, L, k, dome); scene.fog.near = 14; scene.fog.far = 48;
        A.disc.material.color.set(k.sunDisc);
        A.sun.position.set(k.dir[0] > 0 ? 9 : -9, 8 + k.dir[1] * 4, -40); A.sun.lookAt(0, 1, 5);
      }
      // pets: keep the ones that didn't change, rebuild the rest
      const keep = new Set();
      const place = (key, it, rider) => {
        const sig = JSON.stringify([it.pet, it.mood, it.stage]);
        let e = pets.get(key);
        if (!e || e.sig !== sig) {
          if (e) { scene.remove(e.obj, e.shadow); e.obj.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
          const obj = buildPet(it.pet, it.mood, it.stage);
          const shadow = blobShadow(0.9, 0.6);
          scene.add(obj); if (!rider) scene.add(shadow);
          e = { obj, shadow, sig, ph: rr(0, 6) }; pets.set(key, e);
        }
        e.rider = rider; e.it = it; keep.add(key);
      };
      items = spec.runners;
      spec.runners.forEach(it => place(it.key, it, false));
      cartInfo = spec.cart;
      if (cartInfo) {
        if (!cart) { cart = buildCart(); scene.add(cart); }
        cartInfo.riders.forEach(it => place('cart:' + it.key, it, true));
      } else if (cart) { scene.remove(cart); cart = null; }
      for (const [k, e] of pets) if (!keep.has(k)) { scene.remove(e.obj, e.shadow); pets.delete(k); }
      c.layout();
      return true;
    },
    // put every pet where the HTML layout says (also after a resize)
    layout() {
      if (!size[1]) return;
      for (const [key, e] of pets) {
        if (e.rider) continue;
        const it = e.it, g = toGround(it.xPct, it.bottomPx + 4); if (!g) continue;
        const s = (it.widthPx * g.mpp) / 1.65;   // the pet fills about 70 % of its box, like the flat drawings
        e.obj.position.copy(g.p); e.obj.scale.setScalar(s * ({ baby: 0.72, kid: 0.86, grown: 1 }[it.stage] || 1));
        e.obj.rotation.set(0, Math.PI / 2 - 0.6, 0);
        e.base = g.p.clone(); e.size = s;
        e.shadow.position.set(g.p.x, 0.012, g.p.z); e.shadow.scale.setScalar(s * 1.1);
        if (it.mood === 'dead') { e.obj.rotation.set(0, 0.3, Math.PI / 2 - 0.15); e.obj.position.y += 0.32 * s; }
        if (it.mood === 'fainting') { e.obj.rotation.set(0.25, 0.4, 0); e.obj.userData.inner.scale.y = 0.85; }
      }
      if (cart && cartInfo) {
        const g = toGround(cartInfo.xPct, cartInfo.bottomPx + 6); if (!g) return;
        const s = (cartInfo.widthPx * g.mpp) / 1.45;
        cart.position.copy(g.p); cart.scale.setScalar(s); cart.rotation.y = -0.18;
        const n = cartInfo.riders.length;
        cartInfo.riders.forEach((it, i) => {
          const e = pets.get('cart:' + it.key); if (!e) return;
          const sc = s * 0.46 * ({ baby: 0.8, kid: 0.9, grown: 1 }[it.stage] || 1);
          e.obj.scale.setScalar(sc); e.obj.rotation.set(0, 0.25, 0);
          const local = new THREE.Vector3((n === 1 ? 0 : (i / (n - 1) - 0.5) * 0.62), 0.3, 0.02).applyAxisAngle(new THREE.Vector3(0, 1, 0), cart.rotation.y);
          e.obj.position.copy(cart.position).addScaledVector(local, s);
          e.obj.userData.inner.scale.y = 0.92;
        });
      }
    },
    detach() { c.active = false; container = null; if (io) { io.disconnect(); io = null; } },
    resize() {
      if (!container) return;
      const w = Math.max(1, Math.round(container.clientWidth)), h = Math.max(1, Math.round(container.clientHeight));
      if (w !== size[0] || h !== size[1]) {
        size = [w, h]; R.setSize(w, h, false); R.domElement.style.width = R.domElement.style.height = '100%';
        cam.aspect = w / h;
        // keep the track the same height on any phone: widen the view on wide screens
        cam.position.set(0, 2.5, 8.6); cam.lookAt(0, 0.75, 0); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
        c.layout();
      }
    },
    frame(t) {
      if (!c.active || !container || !container.isConnected) { c.active = false; return; }
      if (!visible) return;
      if (R.domElement.parentNode !== container) { container.prepend(R.domElement); size = [0, 0]; }
      c.resize();
      const now = t / 1000;
      const moving = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      const dx = moving ? SPEED * (c.lastT ? Math.min(0.1, now - c.lastT) : 0) : 0; c.lastT = now;
      // stream the world to the left
      A.movers.forEach(o => { o.position.x -= dx; if (o.position.x < -SPAN / 2 - 2) o.position.x += SPAN + 4; });
      const off = (now * SPEED) % 1000;
      A.track.offset.x = (off / 2) % 1; A.dash.offset.x = (off / 1.2) % 1; A.verge.offset.x = (off / 1.2) % 1; A.field.offset.x = (off / 1.2) % 1;
      A.far.position.x = -((now * 0.15) % 8);
      // running pets
      for (const [, e] of pets) {
        if (e.rider || !e.base) continue;
        const it = e.it, ud = e.obj.userData;
        if (it.mood === 'dead' || it.mood === 'fainting' || !moving) continue;
        const period = parseFloat(it.spd) || 0.5, ph = (now / period) * Math.PI * 2 + e.ph, step = Math.sin(ph);
        ud.feet[0].position.z = ud.feet[0].userData.z0 + step * 0.13; ud.feet[1].position.z = ud.feet[1].userData.z0 - step * 0.13;
        ud.feet[0].position.y = 0.07 + Math.max(0, step) * 0.06; ud.feet[1].position.y = 0.07 + Math.max(0, -step) * 0.06;
        ud.inner.position.y = Math.abs(Math.cos(ph)) * 0.05;
        ud.inner.rotation.x = 0.1;
        e.obj.position.y = e.base.y + Math.abs(Math.cos(ph)) * 0.02 * e.size;
      }
      if (cart && cart.userData.wheels && !(cartInfo && cartInfo.parked) && moving) cart.userData.wheels.forEach(w => { w.rotation.z -= dx / (0.17 * cart.scale.x); });
      R.render(scene, cam);
    },
  };
  return c;
}
