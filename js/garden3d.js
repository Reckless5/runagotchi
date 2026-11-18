/* Runagotchi 3D garden (My pet screen), retro console style (see gc3d.js).
   Same layout as tools/blender/make_garden.py: 1 unit = 1 m = 100 px of the old flat garden.
   three.js axes: x right, y up, z towards the camera (far away = negative z).
   The pet's walking spots (ROAM_SPOTS in app.js) match the pond, tree and palm placed here. */
import { buildPet } from './pet3d.js';
import { THREE, renderer, TEX, lam, texMat, SKIES, applySky, lights, blobShadow, palm, tree, pine, rock, flower, grassTuft, terrain, rr } from './gc3d.js';

const W = 2.8, PERSP = 4.2, EYE = 0.42 * W;
const at = (xPct, zPx) => [(xPct - 50) / 100 * W, zPx / 100];

function buildWorld(scene) {
  const anim = {};
  // ground: flat play area, soft hills around it (distance outside the play area → height)
  const flat = (x, z) => Math.max(Math.abs(x) - 3.2, -4.6 - z, z - 3.5);
  const ground = terrain(44, 44, flat, 0, -10, 72); scene.add(ground);
  const hAt = (x, z) => Math.max(0, ground.userData.heightAt(x, z));
  // pond with a cobble rim and moving water
  const pond = new THREE.Group(); pond.position.set(0.36 * W, 0, -1.65); pond.scale.set(0.67, 1, 1.1); scene.add(pond);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 6, 32), texMat(TEX.stone(), 8, 1)); rim.rotation.x = -Math.PI / 2; rim.scale.z = 0.6; rim.position.y = 0.03;
  const bed = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), lam({ color: '#1f6fa8' })); bed.rotation.x = -Math.PI / 2; bed.position.y = 0.004;
  const wt = TEX.water().clone(); wt.needsUpdate = true; wt.repeat.set(1.5, 1.5); anim.water = wt;
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), lam({ map: wt, transparent: true, opacity: 0.85, emissive: '#0a3a5a', emissiveIntensity: 0.3 }));
  water.rotation.x = -Math.PI / 2; water.position.y = 0.02;
  pond.add(bed, water, rim);
  // rocky cliff with a waterfall (x 30 %, z −700)
  const [cx, cz] = at(30, -700);
  const cg = new THREE.CylinderGeometry(0.85, 1.05, 2.7, 10, 4); const cp = cg.attributes.position;
  for (let i = 0; i < cp.count; i++) { const k = 1 + 0.12 * Math.sin(cp.getY(i) * 5 + Math.atan2(cp.getX(i), cp.getZ(i)) * 3); cp.setX(i, cp.getX(i) * k); cp.setZ(i, cp.getZ(i) * k); }
  cg.computeVertexNormals();
  const cy0 = hAt(cx, cz);
  const cliff = new THREE.Mesh(cg, texMat(TEX.rock(), 3, 2)); cliff.position.set(cx, cy0 + 1.3, cz); scene.add(cliff);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.9, 0.18, 10), texMat(TEX.grass(), 1.5, 0.3)); cap.position.set(cx, cy0 + 2.68, cz); scene.add(cap);
  const ft = TEX.fall().clone(); ft.needsUpdate = true; ft.repeat.set(1, 2); anim.fall = ft;
  const fall = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 2.5), lam({ map: ft, transparent: true, opacity: 0.92, emissive: '#5aa8d8', emissiveIntensity: 0.35 }));
  fall.position.set(cx + 0.05, cy0 + 1.32, cz + 1.0); scene.add(fall);
  const foamMat = lam({ color: '#ffffff', transparent: true, opacity: 0.85, emissive: '#ffffff', emissiveIntensity: 0.3 });
  anim.foam = [];
  for (let k = 0; k < 6; k++) { const f = new THREE.Mesh(new THREE.IcosahedronGeometry(rr(0.08, 0.14), 0), foamMat); f.position.set(cx + rr(-0.22, 0.28), cy0 + 0.06, cz + 1.05 + rr(-0.05, 0.1)); f.userData.ph = rr(0, 6); scene.add(f); anim.foam.push(f); }
  for (const [dx, dz, s] of [[-1.1, 0.4, 0.7], [1.0, 0.6, 0.55], [1.5, -0.2, 0.8]]) { const r = rock(s); r.position.set(cx + dx, hAt(cx + dx, cz + dz) + 0.05, cz + dz); scene.add(r); }
  // palms, trees, flowers — the near palm and the fruit tree are walking spots
  const put = (o, x, z, ry = 0) => { o.position.set(x, hAt(x, z), z); o.rotation.y = ry; scene.add(o); return o; };
  put(palm(1.7), ...at(4, -140), 0.4);
  put(palm(1.3, 0.12), ...at(75, -560), 2.1);
  put(tree(1.05), ...at(92, -230));
  put(palm(2.1, 0.1), -3.6, -6.2, 1.2); put(palm(1.8, 0.14), 3.9, -4.8, 2.6); put(palm(1.5), -4.4, -2.4, 0.2);
  put(tree(1.2, false), 4.6, -7.5); put(pine(1.6), -6.2, -9); put(pine(2), 6.5, -10.5); put(pine(1.4), -2.4, -11.5); put(tree(0.9), -4.8, 0.6);
  const petals = ['#ff7eb6', '#ffffff', '#ffd23f', '#8fd0ff', '#ff9a5a'];
  const spots = [[-1.25, 0.7], [1.35, 0.9], [-0.9, -0.6], [1.9, -0.2], [-1.8, -1.7], [2.3, -2.9], [-2.6, 0.2], [0.6, 1.4], [-0.5, -3.3], [1.4, -3.8], [2.7, 1.3], [-2.2, 1.6]];
  spots.forEach(([x, z], i) => { const f = flower(petals[i % petals.length], rr(0.8, 1.2)); f.position.set(x, 0, z); scene.add(f); });
  for (let i = 0; i < 26; i++) { const x = rr(-3.4, 3.4), z = rr(-4.6, 1.8); if (Math.abs(x) < 0.4 || Math.hypot(x - 1.0, z + 1.65) < 0.7) continue; const t = grassTuft(rr(0.8, 1.3)); t.position.set(x, 0, z); scene.add(t); }
  // sun / moon: a glowing disc far away
  const glow = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32), new THREE.MeshBasicMaterial({ map: TEX.blob(), color: '#ffffff', transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.7, 32), new THREE.MeshBasicMaterial({ color: '#fff6c8', fog: false }));
  const sunG = new THREE.Group(); sunG.add(glow, disc); glow.position.z = -0.01; scene.add(sunG); anim.sun = sunG; anim.disc = disc;
  return anim;
}

export function createGarden() {
  let R = null, scene, cam, L, anim, pet = null, petShadow = null, petKey = '', tod = '', dome = null, container = null;
  let view = { x: 0, z: 0 }, heading = 0, size = 0, visible = true, io = null;
  const g = {
    active: false,
    ok: true,
    attach(el, spec) {
      R = renderer();
      if (!R) { g.ok = false; return false; }
      if (!scene) {
        scene = new THREE.Scene();
        cam = new THREE.PerspectiveCamera(2 * Math.atan(W / 2 / PERSP) * 180 / Math.PI, 1, 0.05, 90);
        L = lights(scene); anim = buildWorld(scene);
        petShadow = blobShadow(0.95, 0.75); scene.add(petShadow);
      }
      container = el; g.active = true;
      if (R.domElement.parentNode !== el) {
        el.prepend(R.domElement); size = 0;
        if (io) io.disconnect();
        if ('IntersectionObserver' in window) { io = new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; }); io.observe(el); }
      }
      g.resize();
      if (spec.tod !== tod) g.setTime(spec.tod);
      const key = JSON.stringify([spec.pet, spec.mood, spec.stage]);
      if (key !== petKey) {
        if (pet) { scene.remove(pet); pet.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
        pet = buildPet(spec.pet, spec.mood, spec.stage); scene.add(pet); petKey = key;
        const sc = { baby: 0.72, kid: 0.86, grown: 1 }[spec.stage] || 1; petShadow.scale.set(sc, sc, 1);
      }
      return true;
    },
    detach() { g.active = false; container = null; if (io) { io.disconnect(); io = null; } },
    resize() {
      if (!container) return;
      const s = Math.max(1, Math.round(container.clientWidth));
      if (s !== size) { size = s; R.setSize(s, s, false); R.domElement.style.width = R.domElement.style.height = '100%'; cam.aspect = 1; cam.updateProjectionMatrix(); }
    },
    setTime(t) {
      tod = t; const k = SKIES[t] || SKIES.day;
      dome = applySky(scene, L, k, dome);
      anim.disc.material.color.set(k.sunDisc);
      const d = new THREE.Vector3(...k.dir).normalize();
      anim.sun.position.set(d.x * 40, Math.max(6, d.y * 22), -Math.abs(d.z) * 40 - 10);
      anim.sun.lookAt(0, 1, 4);
    },
    /* tilt: {x, y} −1…1 · p: {x, z} pet position in old px units, y: hop (px, negative = up), heading (rad), state */
    frame(t, tilt, p) {
      if (!g.active || !container || !container.isConnected) { g.active = false; return null; }
      if (!visible) return g.lastHead || null;   // scrolled out of view: don't draw
      if (R.domElement.parentNode !== container) { container.prepend(R.domElement); size = 0; }
      g.resize();
      const px = p.x / 100, pz = p.z / 100, now = t / 1000;
      if (pet) {
        pet.position.set(px, -p.y / 100, pz);
        petShadow.position.set(px, 0.012, pz); petShadow.material.opacity = 1 - Math.min(0.6, -p.y / 40);
        let d = p.heading - heading; d = Math.atan2(Math.sin(d), Math.cos(d)); heading += d * 0.2;
        pet.rotation.y = heading;
        const ud = pet.userData, s = p.state;
        const walk = s === 'walk', step = walk ? Math.sin(now * (p.slow ? 5 : 9)) : 0;
        ud.feet[0].position.z = ud.feet[0].userData.z0 + step * 0.09; ud.feet[1].position.z = ud.feet[1].userData.z0 - step * 0.09;
        ud.inner.position.y = walk ? Math.abs(step) * 0.03 : 0;
        ud.inner.rotation.x = s === 'drink' || s === 'eat' ? (Math.sin(now * 6) > 0.3 ? 0.35 : 0.15) : walk ? 0.06 : 0;
        const rest = s === 'sit' || s === 'sleep';
        ud.inner.scale.y += ((rest ? 0.9 : 1) - ud.inner.scale.y) * 0.15;
        ud.inner.rotation.z = s === 'sleep' ? Math.sin(now * 1.2) * 0.04 : 0;
      }
      // camera: locked on the pet, orbiting with the tilt
      view.x += (px - view.x) * 0.14; view.z += (pz - view.z) * 0.14;
      const yaw = tilt.x * 11 * Math.PI / 180, pitch = tilt.y * 6 * Math.PI / 180;
      const ax = new THREE.Vector3(1, 0, 0), ay = new THREE.Vector3(0, 1, 0);
      const off = new THREE.Vector3(0, EYE, PERSP).applyAxisAngle(ax, -pitch).applyAxisAngle(ay, yaw);
      cam.position.set(view.x + off.x, off.y, view.z + off.z);
      cam.lookAt(cam.position.clone().add(new THREE.Vector3(0, -0.04, -1).applyAxisAngle(ax, -pitch).applyAxisAngle(ay, yaw)));
      // moving water
      anim.fall.offset.y = (now * 0.9) % 1;
      anim.water.offset.set((now * 0.03) % 1, (now * 0.05) % 1);
      anim.foam.forEach(f => { const s = 0.8 + 0.35 * Math.sin(now * 5 + f.userData.ph); f.scale.setScalar(s); });
      R.render(scene, cam);
      if (!pet) return null;
      const head = new THREE.Vector3(px, pet.userData.height - p.y / 100 + 0.12, pz).project(cam);
      return (g.lastHead = { x: (head.x + 1) / 2, y: (1 - head.y) / 2 });
    },
  };
  return g;
}
