import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

/* ============ config ============ */
const FOOD_PER_KM = 10, MAX_FOOD = 100, START_FOOD = 70, GRACE_H = 72, REVIVE_KM = 5;
const DIFF = {
  easy:   { label: 'Chill',  km: 10 },
  normal: { label: 'Steady', km: 20 },
  hard:   { label: 'Beast',  km: 35 }
};
const COLORS = { tangerine:'#ff8a4c', mint:'#5fd3a5', sky:'#6fb6ff', lilac:'#b48cff', lemon:'#ffd84d', bubblegum:'#ff7eb6' };
const SHAPES = {
  blob:   { label:'Blob',   d:'M100 66c40 0 64 30 64 62s-26 46-64 46-64-14-64-46 24-62 64-62z', top:66, face:118, ex:22 },
  bean:   { label:'Bean',   d:'M100 52c30 0 48 22 48 52v40c0 22-20 32-48 32s-48-10-48-32v-40c0-30 18-52 48-52z', top:52, face:104, ex:20 },
  pebble: { label:'Pebble', d:'M100 88c46 0 76 22 76 46s-30 40-76 40-76-16-76-40 30-46 76-46z', top:88, face:128, ex:26 },
  drop:   { label:'Drop',   d:'M100 50c18 26 60 58 60 88 0 26-26 38-60 38s-60-12-60-38c0-30 42-62 60-88z', top:56, face:132, ex:20 }
};
const PATTERNS = { none:'Plain', spots:'Spots', belly:'Belly' };
const ACCS = { none:'None', headband:'Headband', cap:'Cap', sprout:'Sprout', bow:'Bow' };
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const LS_KEY = 'runagotchi.v1', LS_GUEST = 'runagotchi.guest';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ============ state ============ */
let sb = null;              // Supabase client (null = no accounts configured)
let mode = 'local';         // 'local' (this device) | 'cloud' (account)
let screen = 'boot';        // boot | auth | username | app | error
let currentUid;             // undefined until the first auth event
let profile = null;         // { id, username }
let userEmail = '';
let S = null;               // { pet, runs }
let tab = 'pet';            // pet | friends
let devOffset = 0;          // time machine (local mode only)
let draft = null;           // pet being created / edited
let showAllRuns = false;
let authMode = 'login';
let friends = { loaded: false, loading: false, error: false, rows: [], profiles: {}, pets: {} };
const now = () => Date.now() + devOffset;
const H = 3.6e6, D = 24 * H;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $ = s => document.querySelector(s);

/* ============ hunger simulation ============ */
// Replays the pet's whole life from birth: food drains steadily, runs add food.
// At 0 food the pet faints; after GRACE_H hours fainted it starves.
// A run of REVIVE_KM+ km brings a starved pet back.
function simulate(st, tNow) {
  const p = st.pet;
  const decayH = DIFF[p.difficulty].km * FOOD_PER_KM / 7 / 24; // food per hour
  let t = p.createdAt, f = START_FOOD, dead = false, zeroAt = null, deathAt = null;
  let fedKm = 0, lastFeed = null, revives = 0;
  const adv = to => {
    if (to <= t) return;
    if (!dead) {
      const h = (to - t) / H;
      if (f > 0) {
        const hz = f / decayH;
        if (h < hz) f -= decayH * h;
        else { zeroAt = t + hz * H; f = 0; }
      }
      if (f === 0 && zeroAt !== null && to - zeroAt >= GRACE_H * H) { dead = true; deathAt = zeroAt + GRACE_H * H; }
    }
    t = to;
  };
  const runs = st.runs.filter(r => r.date >= p.createdAt && r.date <= tNow).sort((a, b) => a.date - b.date);
  for (const r of runs) {
    adv(r.date);
    if (dead) {
      if (r.km >= REVIVE_KM) { dead = false; deathAt = null; zeroAt = null; f = Math.min(MAX_FOOD, r.km * FOOD_PER_KM); revives++; fedKm += r.km; lastFeed = r.date; }
    } else {
      f = Math.min(MAX_FOOD, f + r.km * FOOD_PER_KM);
      if (f > 0) zeroAt = null;
      fedKm += r.km; lastFeed = r.date;
    }
  }
  adv(tNow);
  return { f, dead, zeroAt, deathAt, fedKm, lastFeed, decayH, revives };
}
// A friend's pet: continue the countdown from the snapshot their app saved.
function simulateSnapshot(row, tNow) {
  const decayH = DIFF[row.difficulty].km * FOOD_PER_KM / 7 / 24;
  const t0 = Date.parse(row.snapshot_at);
  let f = Number(row.food), dead = !!row.dead;
  let zeroAt = row.zero_at ? Date.parse(row.zero_at) : null, deathAt = row.death_at ? Date.parse(row.death_at) : null;
  if (!dead && tNow > t0) {
    const h = (tNow - t0) / H;
    if (f > 0) { const hz = f / decayH; if (h < hz) f -= decayH * h; else { zeroAt = t0 + hz * H; f = 0; } }
    if (f === 0 && zeroAt !== null && tNow - zeroAt >= GRACE_H * H) { dead = true; deathAt = zeroAt + GRACE_H * H; }
  }
  return { f, dead, zeroAt, deathAt, decayH };
}
function moodOf(sim) {
  if (sim.dead) return 'dead';
  if (sim.f <= 0) return 'fainting';
  if (sim.f < 15) return 'starving';
  if (sim.f < 40) return 'hungry';
  if (sim.f < 70) return 'content';
  return 'happy';
}
const stageOf = km => km < 25 ? 'baby' : km < 100 ? 'kid' : 'grown';
const levelOf = km => Math.floor(Math.sqrt(km / 2)) + 1;

/* ============ pet drawing ============ */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = v => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return '#' + [m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function petSVG(p, mood, stage, id) {
  const sh = SHAPES[p.shape] || SHAPES.blob;
  const dead = mood === 'dead';
  const col = dead ? '#d6d6d0' : (COLORS[p.color] || COLORS.tangerine);
  const dark = shade(col, -0.35), ink = '#2b2a22';
  const scale = { baby: .72, kid: .86, grown: 1 }[stage] || 1;
  const ey = sh.face, ex = sh.ex, L = 100 - ex, R = 100 + ex;
  const clip = 'bc' + id;
  let pattern = '';
  if (p.pattern === 'spots') pattern = `<g fill="${shade(col, .35)}"><circle cx="66" cy="${sh.top + 30}" r="9"/><circle cx="138" cy="${sh.top + 46}" r="12"/><circle cx="62" cy="${ey + 34}" r="7"/><circle cx="146" cy="${ey + 30}" r="6"/></g>`;
  if (p.pattern === 'belly') pattern = `<ellipse cx="100" cy="${ey + 46}" rx="40" ry="30" fill="${shade(col, .5)}"/>`;
  const band = p.acc === 'headband' ? `<rect x="0" y="${sh.top + 12}" width="200" height="12" fill="#e8403a"/><rect x="0" y="${sh.top + 16}" width="200" height="3" fill="#fff" opacity=".7"/>` : '';
  let eyes = '', mouth = '', extra = '';
  const eyeDot = x => `<circle cx="${x}" cy="${ey}" r="6.5" fill="${ink}"/><circle cx="${x + 2}" cy="${ey - 2.5}" r="2.2" fill="#fff"/>`;
  switch (mood) {
    case 'happy':
      eyes = [L, R].map(x => `<path d="M${x - 8} ${ey + 3}q8 -12 16 0" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`).join('');
      mouth = `<path d="M87 ${ey + 13}q13 16 26 0z" fill="${ink}"/><path d="M93 ${ey + 18}q7 5 14 0" fill="#ff7a8a"/>`;
      extra = `<ellipse cx="${L - 10}" cy="${ey + 13}" rx="8" ry="5" fill="#ff7a8a" opacity=".55"/><ellipse cx="${R + 10}" cy="${ey + 13}" rx="8" ry="5" fill="#ff7a8a" opacity=".55"/>`;
      break;
    case 'content':
      eyes = eyeDot(L) + eyeDot(R);
      mouth = `<path d="M92 ${ey + 15}q8 8 16 0" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`;
      extra = `<ellipse cx="${L - 10}" cy="${ey + 13}" rx="7" ry="4" fill="#ff7a8a" opacity=".35"/><ellipse cx="${R + 10}" cy="${ey + 13}" rx="7" ry="4" fill="#ff7a8a" opacity=".35"/>`;
      break;
    case 'hungry':
      eyes = eyeDot(L) + eyeDot(R) + `<path d="M${L - 9} ${ey - 14}l14 5M${R + 9} ${ey - 14}l-14 5" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`;
      mouth = `<ellipse cx="100" cy="${ey + 18}" rx="5" ry="6.5" fill="${ink}"/>`;
      break;
    case 'starving':
      eyes = [L, R].map(x => `<path d="M${x - 8} ${ey}h16" stroke="${ink}" stroke-width="4" stroke-linecap="round"/><path d="M${x - 6} ${ey + 1}q6 7 12 0" fill="${ink}"/>`).join('');
      mouth = `<path d="M86 ${ey + 20}q3.5 -5 7 0t7 0t7 0t7 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
      extra = `<path d="M${R + 24} ${ey - 20}q-6 10 0 13q6 -3 0 -13z" fill="#6fb6ff"/>`;
      break;
    case 'fainting':
      eyes = [L, R].map(x => `<circle cx="${x}" cy="${ey}" r="7" fill="none" stroke="${ink}" stroke-width="2.5"/><circle cx="${x}" cy="${ey}" r="2.5" fill="none" stroke="${ink}" stroke-width="2.5"/>`).join('');
      mouth = `<ellipse cx="100" cy="${ey + 18}" rx="8" ry="3" fill="${ink}"/>`;
      break;
    case 'dead':
      eyes = [L, R].map(x => `<path d="M${x - 6} ${ey - 6}l12 12M${x + 6} ${ey - 6}l-12 12" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`).join('');
      mouth = `<path d="M92 ${ey + 18}h16" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
      extra = `<ellipse cx="100" cy="${sh.top - 14}" rx="26" ry="7" fill="none" stroke="#c9a227" stroke-width="4"/>`;
      break;
  }
  let acc = '';
  if (p.acc === 'cap') acc = `<path d="M${100 - 34} ${sh.top + 10}q34 -34 68 0z" fill="#2d4f9e"/><path d="M${100 + 30} ${sh.top + 8}q26 2 30 10q-16 2 -32 -2z" fill="#1f3a78"/><circle cx="100" cy="${sh.top - 7}" r="4" fill="#fff"/>`;
  if (p.acc === 'sprout') acc = `<path d="M100 ${sh.top + 2}v-18" stroke="#3f8f4f" stroke-width="4" stroke-linecap="round"/><path d="M100 ${sh.top - 14}q-18 -12 -24 2q14 8 24 -2z" fill="#5fbf6f"/><path d="M100 ${sh.top - 16}q16 -14 24 -2q-12 10 -24 2z" fill="#4caf5f"/>`;
  if (p.acc === 'bow') acc = `<g transform="translate(${100 + 26} ${sh.top + 10}) rotate(18)"><path d="M0 0l-16 -10v20z" fill="#ff4f8b"/><path d="M0 0l16 -10v20z" fill="#ff4f8b"/><circle r="5" fill="#e0306f"/></g>`;
  const feet = dead ? '' : `<ellipse cx="78" cy="175" rx="14" ry="7" fill="${dark}"/><ellipse cx="122" cy="175" rx="14" ry="7" fill="${dark}"/>`;
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><clipPath id="${clip}"><path d="${sh.d}"/></clipPath></defs>
    ${dead ? '' : '<ellipse cx="100" cy="182" rx="56" ry="6" fill="rgba(0,0,0,.13)"/>'}
    <g transform="translate(100 180) scale(${scale}) translate(-100 -180)">
      <g class="pet-anim m-${mood}">
        ${feet}
        <path d="${sh.d}" fill="${col}"/>
        <g clip-path="url(#${clip})">${pattern}${band}<path d="${sh.d}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="10" transform="translate(-4 -6)"/></g>
        <path d="${sh.d}" fill="none" stroke="${dark}" stroke-width="3"/>
        ${extra}${eyes}${mouth}${acc}
      </g>
    </g>
  </svg>`;
}

/* ============ file parsers (COROS exports) ============ */
const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in unix seconds
function parseFIT(buf) {
  const dv = new DataView(buf);
  const hs = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== '.FIT') throw new Error('Not a FIT file');
  const end = Math.min(hs + dataSize, buf.byteLength);
  let pos = hs;
  const defs = {}, sessions = [], records = [];
  let sport = null;
  const rd = (size, little) => {
    let v;
    if (size === 1) v = dv.getUint8(pos);
    else if (size === 2) v = dv.getUint16(pos, little);
    else if (size === 4) v = dv.getUint32(pos, little);
    else v = null;
    pos += size;
    return v;
  };
  while (pos < end) {
    const hdr = dv.getUint8(pos++);
    let local, isDef = false;
    if (hdr & 0x80) local = (hdr >> 5) & 3;
    else { local = hdr & 0x0f; isDef = !!(hdr & 0x40); }
    if (isDef) {
      const hasDev = !!(hdr & 0x20);
      pos++; // reserved
      const little = dv.getUint8(pos++) === 0;
      const gmn = dv.getUint16(pos, little); pos += 2;
      const nf = dv.getUint8(pos++);
      const fields = [];
      for (let i = 0; i < nf; i++) { fields.push({ num: dv.getUint8(pos), size: dv.getUint8(pos + 1) }); pos += 3; }
      let devSize = 0;
      if (hasDev) { const nd = dv.getUint8(pos++); for (let i = 0; i < nd; i++) { devSize += dv.getUint8(pos + 1); pos += 3; } }
      defs[local] = { gmn, little, fields, devSize };
    } else {
      const d = defs[local];
      if (!d) throw new Error('Corrupt FIT file');
      const vals = {};
      for (const f of d.fields) vals[f.num] = rd(f.size, d.little);
      pos += d.devSize;
      if (d.gmn === 18) sessions.push(vals);                      // session
      else if (d.gmn === 12 && vals[0] != null) sport = vals[0];  // sport
      else if (d.gmn === 20) records.push(vals);                  // record
    }
  }
  const ok = (v, bad) => v != null && v !== bad;
  const out = [];
  for (const s of sessions) {
    if (!ok(s[9], 0xFFFFFFFF)) continue;
    const sp = ok(s[5], 0xFF) ? s[5] : sport;
    out.push({
      date: ok(s[2], 0xFFFFFFFF) ? (s[2] + FIT_EPOCH) * 1000 : (ok(s[253], 0xFFFFFFFF) ? (s[253] + FIT_EPOCH) * 1000 : null),
      km: s[9] / 100 / 1000,
      durMin: ok(s[8], 0xFFFFFFFF) ? s[8] / 1000 / 60 : (ok(s[7], 0xFFFFFFFF) ? s[7] / 1000 / 60 : null),
      isRun: sp == null || sp === 1
    });
  }
  if (!out.length && records.length) { // fallback: last record distance
    const withDist = records.filter(r => ok(r[5], 0xFFFFFFFF) && ok(r[253], 0xFFFFFFFF));
    if (withDist.length) {
      const a = withDist[0], b = withDist[withDist.length - 1];
      out.push({ date: (a[253] + FIT_EPOCH) * 1000, km: b[5] / 100 / 1000, durMin: (b[253] - a[253]) / 60, isRun: sport == null || sport === 1 });
    }
  }
  return out.filter(a => a.date);
}
const kids = (el, name) => Array.from(el.children).filter(c => c.localName === name);
const all = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
function parseTCX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Bad TCX');
  return all(doc, 'Activity').map(a => {
    const sport = a.getAttribute('Sport') || '';
    const idEl = kids(a, 'Id')[0];
    let m = 0, sec = 0;
    for (const lap of kids(a, 'Lap')) {
      const dm = kids(lap, 'DistanceMeters')[0], ts = kids(lap, 'TotalTimeSeconds')[0];
      if (dm) m += parseFloat(dm.textContent) || 0;
      if (ts) sec += parseFloat(ts.textContent) || 0;
    }
    const startAttr = kids(a, 'Lap')[0] && kids(a, 'Lap')[0].getAttribute('StartTime');
    return { date: Date.parse(idEl ? idEl.textContent.trim() : startAttr), km: m / 1000, durMin: sec ? sec / 60 : null, isRun: !sport || /run/i.test(sport) };
  }).filter(a => !isNaN(a.date));
}
function hav(a, b) {
  const R = 6371.0088, rad = x => x * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Bad GPX');
  return all(doc, 'trk').map(trk => {
    const type = (kids(trk, 'type')[0] || {}).textContent || '';
    let km = 0, t0 = null, t1 = null;
    for (const seg of kids(trk, 'trkseg')) {
      let prev = null;
      for (const pt of kids(seg, 'trkpt')) {
        const p = [parseFloat(pt.getAttribute('lat')), parseFloat(pt.getAttribute('lon'))];
        if (isNaN(p[0]) || isNaN(p[1])) continue;
        if (prev) km += hav(prev, p);
        prev = p;
        const te = kids(pt, 'time')[0];
        if (te) { const t = Date.parse(te.textContent); if (!isNaN(t)) { if (t0 == null) t0 = t; t1 = t; } }
      }
    }
    if (t0 == null) { const mt = all(doc, 'time')[0]; if (mt) t0 = Date.parse(mt.textContent); }
    return { date: t0, km, durMin: t0 != null && t1 != null && t1 > t0 ? (t1 - t0) / 60000 : null, isRun: !type || /run/i.test(type) };
  }).filter(a => a.date != null && !isNaN(a.date));
}

/* ============ storage ============ */
function loadLocal() { try { const t = localStorage.getItem(LS_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
function clearLocal() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }
const isGuest = () => { try { return localStorage.getItem(LS_GUEST) === '1'; } catch (e) { return false; } };
const setGuest = v => { try { v ? localStorage.setItem(LS_GUEST, '1') : localStorage.removeItem(LS_GUEST); } catch (e) {} };

const rowToPet = r => ({ name: r.name, shape: r.shape, color: r.color, pattern: r.pattern, acc: r.acc, difficulty: r.difficulty, createdAt: Date.parse(r.born_at) });
const rowToRun = r => ({ id: r.id, date: Date.parse(r.started_at), km: Number(r.km), durMin: r.dur_min == null ? null : Number(r.dur_min), source: r.source });
const runToRow = r => ({ id: r.id, user_id: profile.id, started_at: new Date(r.date).toISOString(), km: r.km, dur_min: r.durMin || null, source: r.source === 'coros' ? 'coros' : 'manual' });
function snapshotRow() {
  const sim = simulate(S, Date.now());
  const iso = t => t == null ? null : new Date(t).toISOString();
  return { food: Math.round(sim.f * 100) / 100, zero_at: iso(sim.zeroAt), dead: sim.dead, death_at: iso(sim.deathAt),
    level: levelOf(sim.fedKm), stage: stageOf(sim.fedKm), snapshot_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}
function petRow() {
  const p = S.pet;
  return { user_id: profile.id, name: p.name, shape: p.shape, color: p.color, pattern: p.pattern, acc: p.acc, difficulty: p.difficulty,
    born_at: new Date(p.createdAt).toISOString(), ...snapshotRow() };
}
async function cloud(op, what) {
  const { error } = await op;
  if (error) { console.error(what, error); toast(`Couldn't save (${esc(what)}). Check your connection and try again.`); return false; }
  return true;
}
// All writes go through these, so local and account mode behave the same.
async function persistPet() {
  if (mode === 'local') return saveLocal();
  return cloud(sb.from('pets').upsert(petRow()), 'pet');
}
async function persistDeletePet() {
  if (mode === 'local') return saveLocal();
  return cloud(sb.from('pets').delete().eq('user_id', profile.id), 'pet');
}
async function persistAddRuns(runs) {
  if (mode === 'local') return saveLocal();
  if (await cloud(sb.from('runs').insert(runs.map(runToRow)), 'runs')) await pushSnapshot();
}
async function persistDeleteRun(id) {
  if (mode === 'local') return saveLocal();
  if (await cloud(sb.from('runs').delete().eq('id', id), 'run')) await pushSnapshot();
}
async function pushSnapshot() {
  if (mode !== 'cloud' || !S || !S.pet) return;
  await sb.from('pets').update(snapshotRow()).eq('user_id', profile.id);
}

/* ============ helpers ============ */
function fmtHours(h) {
  if (h < 1) return 'under an hour';
  if (h < 36) return Math.round(h) + ' h';
  const d = h / 24;
  return (d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)) + ' days';
}
function fmtAgo(t, ref = now()) {
  const h = (ref - t) / H;
  if (h < 1) return 'just now';
  if (h < 24) return Math.round(h) + ' h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}
const fmtKm = km => (Math.round(km * 100) / 100).toFixed(km < 100 ? 2 : 1);
const fmtDate = t => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function pace(r) {
  if (!r.durMin || !r.km) return '';
  const p = r.durMin / r.km; const m = Math.floor(p), s = Math.round((p - m) * 60);
  return `${m}:${String(s === 60 ? 59 : s).padStart(2, '0')} /km`;
}
function toast(msg, ms = 4200) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const sheetOpen = () => $('#backdrop').classList.contains('open');
function openSheet(html, mount) {
  $('#sheet').innerHTML = html; $('#backdrop').classList.add('open');
  if (mount) mount($('#sheet'));
}
function closeSheet() { $('#backdrop').classList.remove('open'); $('#sheet').innerHTML = ''; }
$('#backdrop').addEventListener('click', e => { if (e.target.id === 'backdrop') closeSheet(); });
function confirmSheet(title, body, okLabel, onOk) {
  openSheet(`<h3>${title}</h3><p class="muted">${body}</p>
    <div class="grid2" style="margin-top:16px"><button class="btn" data-a="no">Cancel</button><button class="btn dark" data-a="ok">${okLabel}</button></div>`,
    el => {
      el.querySelector('[data-a=no]').onclick = closeSheet;
      el.querySelector('[data-a=ok]').onclick = () => { closeSheet(); onOk(); };
    });
}
function localInputValue(t) {
  const d = new Date(t); const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}
const bar = (f, cls = 'hunger') => {
  const segs = Math.ceil(f / 10), lvl = f < 15 ? 'crit' : f < 40 ? 'low' : '';
  return `<div class="${cls} ${lvl}" aria-label="Food ${Math.round(f)} of 100">${Array.from({ length: 10 }, (_, i) => `<i class="${i < segs ? 'on' : ''}"></i>`).join('')}</div>`;
};
const SAMPLE_PET = { shape: 'blob', color: 'tangerine', pattern: 'none', acc: 'headband' };

/* ============ boot & auth ============ */
async function boot() {
  render();
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const { createClient } = await import(SUPABASE_CDN);
      sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    } catch (e) { console.error(e); sb = null; }
  }
  if (!sb) return startLocal();
  sb.auth.onAuthStateChange((event, sess) => {
    if (event === 'PASSWORD_RECOVERY') setTimeout(openNewPasswordSheet, 0);
    const id = sess && sess.user ? sess.user.id : null;
    userEmail = sess && sess.user ? sess.user.email || '' : '';
    if (id !== currentUid) { currentUid = id; setTimeout(() => onSession(id), 0); }
  });
}
function startLocal() {
  mode = 'local'; S = loadLocal(); screen = 'app'; tab = 'pet'; render();
}
async function onSession(uid) {
  closeSheet();
  friends = { loaded: false, loading: false, error: false, rows: [], profiles: {}, pets: {} };
  profile = null; S = null; devOffset = 0;
  if (!uid) {
    if (isGuest()) return startLocal();
    authMode = 'login'; screen = 'auth'; return render();
  }
  setGuest(false);
  screen = 'boot'; render();
  const { data: prof, error } = await sb.from('profiles').select('id,username').eq('id', uid).maybeSingle();
  if (uid !== currentUid) return;
  if (error) { screen = 'error'; return render(); }
  if (!prof) { profile = { id: uid, username: null }; screen = 'username'; return render(); }
  profile = prof;
  await loadAccount();
}
async function loadAccount() {
  const uid = profile.id;
  const [petRes, runRes] = await Promise.all([
    sb.from('pets').select('*').eq('user_id', uid).maybeSingle(),
    sb.from('runs').select('id,started_at,km,dur_min,source').eq('user_id', uid).order('started_at', { ascending: false })
  ]);
  if (uid !== currentUid) return;
  if (petRes.error || runRes.error) { screen = 'error'; return render(); }
  S = { pet: petRes.data ? rowToPet(petRes.data) : null, runs: (runRes.data || []).map(rowToRun) };
  mode = 'cloud'; screen = 'app';
  const local = loadLocal();
  if (local && local.pet && !S.pet) await moveLocalToAccount(local);
  render();
  if (S.pet) pushSnapshot();
  loadFriends();
}
// A pet made before logging in moves into the account the first time.
async function moveLocalToAccount(local) {
  const runs = (local.runs || []).map(r => ({ ...r, id: newId(), source: r.source === 'coros' ? 'coros' : 'manual' }));
  S = { pet: local.pet, runs: [...S.runs, ...runs] };
  const okPet = await cloud(sb.from('pets').upsert(petRow()), 'pet');
  const okRuns = !runs.length || await cloud(sb.from('runs').insert(runs.map(runToRow)), 'runs');
  if (okPet && okRuns) { clearLocal(); toast(`Moved <b>${esc(local.pet.name)}</b> and ${runs.length} run${runs.length === 1 ? '' : 's'} into your account.`); }
}

function renderBoot() {
  $('#app').innerHTML = `<header class="top"><div class="brand">Run<span>agotchi</span></div></header><div class="spinner"></div><p class="center muted">Loading…</p>`;
}
function renderError() {
  $('#app').innerHTML = `<header class="top"><div class="brand">Run<span>agotchi</span></div></header>
    <div class="hero" style="margin-top:80px"><h1>Can't reach the server</h1><p>Check your connection and try again.</p></div>
    <button class="btn primary" id="retry" style="width:100%">Try again</button>
    <button class="btn ghost" id="lo" style="width:100%;margin-top:8px">Log out</button>`;
  $('#retry').onclick = () => onSession(currentUid);
  $('#lo').onclick = () => sb.auth.signOut();
}
function renderAuth() {
  const signup = authMode === 'signup';
  $('#app').innerHTML = `
    <div class="auth">
      <header class="top"><div class="brand">Run<span>agotchi</span></div></header>
      <div class="mini">${petSVG(SAMPLE_PET, 'happy', 'grown', 'auth')}</div>
      <div class="hero"><h1>${signup ? 'Create your account' : 'Welcome back'}</h1><p>A pet that lives on the kilometers you run.</p></div>
      <section class="card">
        <div class="seg"><button data-m="login" class="${signup ? '' : 'on'}">Log in</button><button data-m="signup" class="${signup ? 'on' : ''}">Sign up</button></div>
        <form id="af" novalidate>
          <div class="field" style="margin-top:12px"><label for="em">Email</label><input id="em" type="email" class="text" autocomplete="email" required></div>
          <div class="field" style="margin-top:12px"><label for="pw">Password</label><input id="pw" type="password" class="text" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required>
            ${signup ? '<div class="small muted" style="margin-top:6px">At least 6 characters.</div>' : ''}</div>
          <div class="err" id="aerr"></div><div class="ok" id="aok"></div>
          <button class="btn primary" id="asub" style="width:100%">${signup ? 'Create account' : 'Log in'}</button>
        </form>
        ${signup ? '' : '<div class="center"><button class="linkbtn" id="forgot">Forgot password?</button></div>'}
      </section>
      <div class="center"><button class="linkbtn" id="guest" style="color:var(--muted)">Continue without an account</button>
        <div class="small muted">Your pet is saved on this device only, and you can't add friends.</div></div>
    </div>`;
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { authMode = b.dataset.m; renderAuth(); });
  $('#guest').onclick = () => { setGuest(true); startLocal(); };
  if ($('#forgot')) $('#forgot').onclick = async () => {
    const email = $('#em').value.trim();
    if (!email) { $('#aerr').textContent = 'Type your email first, then tap "Forgot password?".'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $('#aerr').textContent = error ? error.message : '';
    $('#aok').textContent = error ? '' : 'Check your email for a link to set a new password.';
  };
  $('#af').onsubmit = async e => {
    e.preventDefault();
    const email = $('#em').value.trim(), password = $('#pw').value;
    const err = $('#aerr'), okEl = $('#aok'); err.textContent = ''; okEl.textContent = '';
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Enter a valid email.'; return; }
    if (signup && password.length < 6) { err.textContent = 'Password needs at least 6 characters.'; return; }
    if (!password) { err.textContent = 'Enter your password.'; return; }
    const btn = $('#asub'); btn.disabled = true;
    if (signup) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      btn.disabled = false;
      if (error) { err.textContent = error.message; return; }
      if (!data.session) okEl.textContent = `Almost there! We sent a confirmation link to ${email}. Open it on this device to log in.`;
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      if (error) err.textContent = /confirm/i.test(error.message) ? 'Please confirm your email first. Check your inbox.' : (/invalid/i.test(error.message) ? 'Wrong email or password.' : error.message);
    }
  };
}
function openNewPasswordSheet() {
  openSheet(`<h3>Set a new password</h3>
    <div class="field" style="margin-top:0"><input id="np" type="password" class="text" autocomplete="new-password" placeholder="New password"></div>
    <div class="err" id="nperr"></div>
    <button class="btn primary" id="npsave" style="width:100%">Save password</button>`, el => {
    el.querySelector('#npsave').onclick = async () => {
      const pw = el.querySelector('#np').value;
      if (pw.length < 6) { el.querySelector('#nperr').textContent = 'At least 6 characters.'; return; }
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) { el.querySelector('#nperr').textContent = error.message; return; }
      closeSheet(); toast('Password updated.');
    };
  });
}
function renderUsername() {
  $('#app').innerHTML = `
    <header class="top"><div class="brand">Run<span>agotchi</span></div><button class="btn small ghost" id="lo">Log out</button></header>
    <div class="hero" style="margin-top:40px"><h1>Pick a username</h1><p>Friends find you by this name.</p></div>
    <section class="card">
      <div class="at"><span>@</span><input id="un" class="text" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="speedy_sam"></div>
      <div class="small muted" style="margin-top:6px">3–20 characters: lowercase letters, numbers and _</div>
      <div class="err" id="uerr"></div>
      <button class="btn primary" id="usave" style="width:100%">Continue</button>
    </section>`;
  const un = $('#un'); un.focus();
  un.addEventListener('input', () => { const v = un.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); if (v !== un.value) un.value = v; });
  un.addEventListener('keydown', e => { if (e.key === 'Enter') $('#usave').click(); });
  $('#lo').onclick = () => sb.auth.signOut();
  $('#usave').onclick = async () => {
    const v = un.value.trim();
    if (!USERNAME_RE.test(v)) { $('#uerr').textContent = 'Use 3–20 lowercase letters, numbers or _.'; return; }
    $('#usave').disabled = true;
    const { error } = await sb.from('profiles').insert({ id: profile.id, username: v });
    $('#usave').disabled = false;
    if (error) { $('#uerr').textContent = error.code === '23505' ? `@${v} is taken. Try another.` : error.message; return; }
    profile = { id: profile.id, username: v };
    screen = 'boot'; render(); loadAccount();
  };
}

/* ============ creator ============ */
function newDraft() { return { name: '', shape: 'blob', color: 'tangerine', pattern: 'none', acc: 'headband', difficulty: 'normal' }; }
function renderCreator(editing) {
  const d = draft;
  const chip = (group, key, label, inner) => `<button class="chip ${d[group] === key ? 'sel' : ''}" data-g="${group}" data-k="${key}">${inner || ''}${label}</button>`;
  $('#app').innerHTML = `
    <header class="top"><div class="brand">Run<span>agotchi</span></div>${editing ? '<button class="btn small ghost" id="cancelEdit">Cancel</button>' : (mode === 'cloud' ? `<span class="small muted">@${esc(profile.username)}</span>` : '')}</header>
    <div class="creator">
      ${editing ? '' : `<div class="hero"><h1>Hatch your pet</h1><p>It lives on the kilometers you run.</p></div>`}
      <div class="preview">${petSVG(d, 'happy', 'grown', 'pv')}</div>
      <div class="field"><label for="nm">Name</label><input id="nm" class="text" maxlength="16" placeholder="e.g. Sprinty" value="${esc(d.name)}" autocomplete="off"></div>
      <div class="field"><span class="lbl">Body</span><div class="chips">${Object.entries(SHAPES).map(([k, v]) => chip('shape', k, v.label, petSVG({ ...d, shape: k, acc: 'none' }, 'content', 'grown', 'sh' + k))).join('')}</div></div>
      <div class="field"><span class="lbl">Color</span><div class="chips">${Object.entries(COLORS).map(([k, v]) => `<button class="sw ${d.color === k ? 'sel' : ''}" style="background:${v}" data-g="color" data-k="${k}" aria-label="${k}"></button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Pattern</span><div class="chips">${Object.entries(PATTERNS).map(([k, v]) => chip('pattern', k, v)).join('')}</div></div>
      <div class="field"><span class="lbl">Accessory</span><div class="chips">${Object.entries(ACCS).map(([k, v]) => chip('acc', k, v)).join('')}</div></div>
      <div class="field"><span class="lbl">Appetite</span><div class="diff">${Object.entries(DIFF).map(([k, v]) => `<button class="chip ${d.difficulty === k ? 'sel' : ''}" data-g="difficulty" data-k="${k}"><b>${v.label}</b><span>~${v.km} km / week</span></button>`).join('')}</div>
        <p class="small muted" style="margin:8px 2px 0">How much your pet needs to eat. Each km you run = ${FOOD_PER_KM} food. A full pet lasts ${Math.round(MAX_FOOD / (DIFF[d.difficulty].km * FOOD_PER_KM / 7) * 10) / 10} days without a run.</p></div>
      <div class="err" id="cerr"></div>
      <button class="btn primary" id="hatch" style="width:100%;margin-top:6px">${editing ? 'Save changes' : 'Hatch'}</button>
    </div>`;
  const nm = $('#nm');
  const label = () => editing ? 'Save changes' : (d.name.trim() ? 'Hatch ' + d.name.trim() : 'Hatch');
  $('#hatch').textContent = label();
  nm.addEventListener('input', () => { d.name = nm.value; $('#hatch').textContent = label(); });
  document.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { d[b.dataset.g] = b.dataset.k; renderCreator(editing); });
  if ($('#cancelEdit')) $('#cancelEdit').onclick = () => { draft = null; render(); };
  $('#hatch').onclick = async () => {
    const name = d.name.trim();
    if (!name) { $('#cerr').textContent = 'Give your pet a name first.'; nm.focus(); return; }
    const look = { name, shape: d.shape, color: d.color, pattern: d.pattern, acc: d.acc, difficulty: d.difficulty };
    if (editing) Object.assign(S.pet, look);
    else S = { pet: { ...look, createdAt: Math.floor(Date.now() / 60000) * 60000 }, runs: S ? S.runs : [] }; // whole minute, so a run logged "now" counts
    draft = null; tab = 'pet'; render();
    await persistPet();
    if (!editing) toast(`${esc(name)} hatched! Go for a run to feed it.`);
  };
}

/* ============ main view ============ */
function header() {
  const right = mode === 'cloud'
    ? `<div class="save-status"><span class="dot cloud"></span>@${esc(profile.username)}</div>`
    : `<div class="save-status"><span class="dot"></span>On this device</div>`;
  const incoming = mode === 'cloud' ? friends.rows.filter(r => r.status === 'pending' && r.addressee === profile.id).length : 0;
  return `<header class="top"><div class="brand">Run<span>agotchi</span></div>${right}</header>
    ${mode === 'cloud' ? `<div class="tabs"><button data-tab="pet" class="${tab === 'pet' ? 'on' : ''}">My pet</button><button data-tab="friends" class="${tab === 'friends' ? 'on' : ''}">Friends${incoming ? `<span class="pill">${incoming}</span>` : ''}</button></div>` : ''}`;
}
function bindHeader() {
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); if (tab === 'friends') loadFriends(); });
}
function statusLine(sim, p) {
  const n = `<b>${esc(p.name)}</b>`;
  const m = moodOf(sim);
  const kmToFull = Math.max(0, (MAX_FOOD - sim.f) / FOOD_PER_KM);
  if (m === 'dead') return { cls: 'bad', html: `${n} starved ${fmtAgo(sim.deathAt)}. A run of ${REVIVE_KM} km or more brings it back.` };
  if (m === 'fainting') return { cls: 'bad', html: `${n} fainted from hunger. <b>${fmtHours(GRACE_H - (now() - sim.zeroAt) / H)}</b> left to save it with a run.` };
  if (m === 'starving') return { cls: 'bad', html: `${n} is starving! Faints in <b>${fmtHours(sim.f / sim.decayH)}</b>. ${kmToFull.toFixed(1)} km fills it up.` };
  if (m === 'hungry') return { cls: '', html: `${n} is getting hungry. Starving in <b>${fmtHours((sim.f - 15) / sim.decayH)}</b>.` };
  if (m === 'content') return { cls: '', html: `${n} is doing fine. Hungry in <b>${fmtHours((sim.f - 40) / sim.decayH)}</b>.` };
  return { cls: '', html: `${n} is stuffed and happy. Hungry in <b>${fmtHours((sim.f - 40) / sim.decayH)}</b>.` };
}
function renderPet() {
  const p = S.pet, t = now();
  const sim = simulate(S, t), mood = moodOf(sim), stage = stageOf(sim.fedKm), lvl = levelOf(sim.fedKm);
  const st = statusLine(sim, p);
  const weekKm = S.runs.filter(r => r.date > t - 7 * D && r.date <= t).reduce((a, r) => a + r.km, 0);
  const sorted = [...S.runs].sort((a, b) => b.date - a.date);
  const shown = showAllRuns ? sorted : sorted.slice(0, 6);
  const goal = DIFF[p.difficulty].km;
  const clock = new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const account = mode === 'cloud'
    ? `<div class="row"><span class="small">Logged in as <b>@${esc(profile.username)}</b>${userEmail ? ` <span class="muted">(${esc(userEmail)})</span>` : ''}</span></div>
       <div class="row" style="margin-top:6px"><button class="btn small" id="logout">Log out</button></div>`
    : (sb ? `<div class="row"><span class="small muted">Saved on this device only.</span></div><div class="row" style="margin-top:6px"><button class="btn small primary" id="toAuth">Log in or sign up</button><span class="small muted">to save online and add friends</span></div>` : '');

  $('#app').innerHTML = `${header()}
    <div class="device">
      <div class="screen ${mood === 'dead' ? 'dead' : ''}" id="screen">
        <div class="lv">LV ${lvl} · ${stage.toUpperCase()}</div><div class="clock">${devOffset ? '⏩ ' : ''}${clock}</div>
        ${petSVG(p, mood, stage, 'main')}
      </div>
      ${bar(sim.f)}
    </div>
    <div class="petname">${esc(p.name)}</div>
    <div class="status ${st.cls}">${st.html}</div>

    <div class="stats">
      <div class="stat"><div class="v">${Math.round(sim.f)}</div><div class="k">food / 100</div></div>
      <div class="stat"><div class="v">${weekKm >= 100 ? Math.round(weekKm) : weekKm.toFixed(1)}</div><div class="k">km this week · goal ${goal}</div></div>
      <div class="stat"><div class="v">${sim.fedKm >= 100 ? Math.round(sim.fedKm) : sim.fedKm.toFixed(1)}</div><div class="k">km fed total</div></div>
    </div>

    <div class="actions">
      <button class="btn primary" id="addRun">+ Log a run</button>
      <button class="btn dark" id="syncBtn">Sync COROS</button>
    </div>

    <section class="card">
      <h2>Runs <span class="small muted">${sim.lastFeed ? 'last fed ' + fmtAgo(sim.lastFeed) : ''}</span></h2>
      ${shown.length ? `<ul class="runs">${shown.map(r => `
        <li>
          <div class="km">${fmtKm(r.km)} km</div>
          <div class="meta">${fmtDate(r.date)}${r.source === 'coros' ? '<span class="badge coros">COROS</span>' : '<span class="badge">Manual</span>'}${r.date < p.createdAt ? '<span class="badge pre">before hatch</span>' : ''}${r.date > t ? '<span class="badge pre">future</span>' : ''}<br>${[r.durMin ? Math.round(r.durMin) + ' min' : '', pace(r)].filter(Boolean).join(' · ')}</div>
          <button class="x" data-del="${r.id}" aria-label="Delete run">×</button>
        </li>`).join('')}</ul>
        ${sorted.length > 6 ? `<button class="btn small ghost" id="moreRuns" style="margin-top:6px">${showAllRuns ? 'Show fewer' : 'Show all ' + sorted.length + ' runs'}</button>` : ''}`
      : `<div class="empty">No runs yet. Log one or sync from COROS to feed ${esc(p.name)}.</div>`}
    </section>

    <section class="card" id="corosCard">
      <h2><span>Sync from COROS</span><span class="coros-logo">COROS</span></h2>
      <p class="small muted" style="margin:0">Drop the files your COROS watch records (.fit, .tcx or .gpx). Runs are added, duplicates and non-run activities are skipped.</p>
      <ol class="steps">
        <li>Open the <b>COROS app</b> and tap a workout.</li>
        <li>Tap the <b>share icon → Export</b> and pick <b>.fit</b>.</li>
        <li>Choose the file here. You can pick several at once.</li>
      </ol>
      <div class="drop" id="drop"><label for="file">Choose files</label> or drop them here
        <input type="file" id="file" accept=".fit,.tcx,.gpx" multiple hidden></div>
      <div class="note">Automatic sync (runs arriving on their own after your watch syncs) needs COROS API access and a small server. That's coming later. This file import uses the same data in the meantime.</div>
    </section>

    <section class="card">
      <details class="settings">
        <summary>Settings</summary>
        ${account}
        <div class="row" style="margin-top:14px"><button class="btn small" id="editPet">Edit ${esc(p.name)}</button><span class="small muted">Appetite: ${DIFF[p.difficulty].label} (~${goal} km/week)</span></div>
        ${mode === 'local' ? `
        <div class="row" style="margin-top:14px"><span class="small"><b>Time machine</b> <span class="muted">(for testing hunger)</span></span></div>
        <div class="row" style="margin-top:6px">
          <button class="btn small" data-tm="12">+12 h</button><button class="btn small" data-tm="24">+1 day</button><button class="btn small" data-tm="72">+3 days</button>
          ${devOffset ? '<button class="btn small" data-tm="0">Back to now</button>' : ''}
        </div>` : ''}
        <div class="row" style="margin-top:14px"><button class="btn small danger" id="restart">Start over with a new pet</button></div>
        <p class="small muted" style="margin:10px 0 0">Born ${fmtDate(p.createdAt)}${sim.revives ? ' · revived ' + sim.revives + '×' : ''}. Runs from before the hatch date are kept but don't count as food.</p>
      </details>
    </section>`;
  bindHeader();
  $('#addRun').onclick = openAddRun;
  $('#syncBtn').onclick = () => { $('#corosCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => $('#file').click(), 350); };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const r = S.runs.find(x => x.id === b.dataset.del); if (!r) return;
    confirmSheet('Delete this run?', `${fmtKm(r.km)} km on ${fmtDate(r.date)}. ${esc(p.name)} will un-eat it.`, 'Delete', () => {
      S.runs = S.runs.filter(x => x.id !== r.id); render(); persistDeleteRun(r.id);
    });
  });
  if ($('#moreRuns')) $('#moreRuns').onclick = () => { showAllRuns = !showAllRuns; render(); };
  const fi = $('#file');
  fi.onchange = () => { if (fi.files.length) handleFiles(Array.from(fi.files)); fi.value = ''; };
  const dz = $('#drop');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); handleFiles(Array.from(e.dataTransfer.files)); });
  $('#editPet').onclick = () => { draft = { ...S.pet }; render(); window.scrollTo(0, 0); };
  document.querySelectorAll('[data-tm]').forEach(b => b.onclick = () => {
    const h = +b.dataset.tm; devOffset = h ? devOffset + h * H : 0; render();
    const d = document.querySelector('details.settings'); if (d) d.open = true;
  });
  if ($('#logout')) $('#logout').onclick = () => sb.auth.signOut();
  if ($('#toAuth')) $('#toAuth').onclick = () => { setGuest(false); authMode = 'signup'; screen = 'auth'; render(); window.scrollTo(0, 0); };
  $('#restart').onclick = () => confirmSheet('Start over?', `${esc(p.name)} will be gone for good. Your runs stay in the log, but only runs after the new pet hatches will feed it.`, 'Start over', async () => {
    S.pet = null; draft = newDraft(); render(); window.scrollTo(0, 0);
    await persistDeletePet();
  });
}
function feedFx(km) {
  const sc = $('#screen'); if (!sc) return;
  const el = document.createElement('div'); el.className = 'float-txt mono'; el.textContent = `+${Math.round(km * FOOD_PER_KM)} food`;
  sc.appendChild(el); setTimeout(() => el.remove(), 1700);
}

/* ============ friends ============ */
async function loadFriends() {
  if (mode !== 'cloud' || friends.loading) return;
  friends.loading = true; friends.error = false;
  if (tab === 'friends') render();
  const me = profile.id;
  try {
    const { data: rows, error } = await sb.from('friendships').select('id,requester,addressee,status,created_at');
    if (error) throw error;
    const other = r => r.requester === me ? r.addressee : r.requester;
    const ids = [...new Set(rows.map(other))];
    const acceptedIds = rows.filter(r => r.status === 'accepted').map(other);
    const [pr, pe] = await Promise.all([
      ids.length ? sb.from('profiles').select('id,username').in('id', ids) : { data: [] },
      acceptedIds.length ? sb.from('pets').select('*').in('user_id', acceptedIds) : { data: [] }
    ]);
    if (pr.error || pe.error) throw (pr.error || pe.error);
    friends = { loaded: true, loading: false, error: false, rows,
      profiles: Object.fromEntries(pr.data.map(p => [p.id, p])), pets: Object.fromEntries(pe.data.map(p => [p.user_id, p])) };
  } catch (e) { console.error(e); friends.loading = false; friends.error = true; }
  if (screen === 'app' && !draft && !sheetOpen() && !isTyping()) render();
}
function friendStatus(sim, row) {
  const m = moodOf(sim);
  if (m === 'dead') return { bad: true, txt: `Starved. Needs a ${REVIVE_KM} km run.` };
  if (m === 'fainting') return { bad: true, txt: `Fainted! ${fmtHours(GRACE_H - (Date.now() - sim.zeroAt) / H)} left.` };
  if (m === 'starving') return { bad: true, txt: 'Starving!' };
  if (m === 'hungry') return { bad: false, txt: 'Getting hungry' };
  if (m === 'content') return { bad: false, txt: 'Doing fine' };
  return { bad: false, txt: 'Stuffed & happy' };
}
function renderFriends() {
  const me = profile.id;
  const name = id => (friends.profiles[id] || {}).username || 'someone';
  const incoming = friends.rows.filter(r => r.status === 'pending' && r.addressee === me);
  const outgoing = friends.rows.filter(r => r.status === 'pending' && r.requester === me);
  const accepted = friends.rows.filter(r => r.status === 'accepted')
    .map(r => ({ row: r, id: r.requester === me ? r.addressee : r.requester }))
    .sort((a, b) => name(a.id).localeCompare(name(b.id)));
  const t = Date.now();
  const card = ({ row, id }) => {
    const pet = friends.pets[id];
    if (!pet) return `<div class="fcard"><div class="scr"></div><div class="nm">No pet yet</div><div class="un">@${esc(name(id))}</div>
      <div class="st muted">Hasn't hatched a pet.</div><button class="more" data-unf="${row.id}" aria-label="Remove friend">⋯</button></div>`;
    const sim = simulateSnapshot(pet, t), mood = moodOf(sim), st = friendStatus(sim, pet);
    return `<div class="fcard">
      <div class="scr ${mood === 'dead' ? 'dead' : ''}">${petSVG(pet, mood, pet.stage, 'f' + id.slice(0, 8))}</div>
      <div class="lv">LV ${pet.level}</div>
      <button class="more" data-unf="${row.id}" aria-label="Remove friend">⋯</button>
      <div class="nm">${esc(pet.name)}</div>
      <div class="un">@${esc(name(id))} · seen ${fmtAgo(Date.parse(pet.snapshot_at), t)}</div>
      ${bar(sim.f, 'minibar')}
      <div class="st ${st.bad ? 'bad' : ''}">${st.txt}</div>
    </div>`;
  };
  $('#app').innerHTML = `${header()}
    <section class="card">
      <h2>Add a friend</h2>
      <div class="addrow">
        <div class="at"><span>@</span><input id="fu" class="text" maxlength="21" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="their username"></div>
        <button class="btn primary" id="fsend">Send</button>
      </div>
      <div class="err" id="ferr"></div><div class="ok" id="fok"></div>
      <div class="small muted">Your username is <b>@${esc(profile.username)}</b>. Send it to friends so they can add you. <button class="linkbtn" id="copyU">Copy</button></div>
    </section>
    ${incoming.length ? `<section class="card"><h2>Friend requests</h2>${incoming.map(r => `
      <div class="req"><div class="who">@${esc(name(r.requester))}</div>
        <button class="btn small" data-dec="${r.id}">Decline</button><button class="btn small primary" data-acc="${r.id}">Accept</button></div>`).join('')}</section>` : ''}
    <section class="card">
      <h2>Friends <button class="btn small ghost" id="frefresh">${friends.loading ? 'Loading…' : 'Refresh'}</button></h2>
      ${friends.error ? `<div class="err">Couldn't load your friends. Check your connection and tap Refresh.</div>` : ''}
      ${!friends.loaded && !friends.error ? `<div class="empty">Loading…</div>` :
        accepted.length ? `<div class="fgrid">${accepted.map(card).join('')}</div>` :
        `<div class="empty">No friends yet. Add someone by their username above.</div>`}
    </section>
    ${outgoing.length ? `<section class="card"><h2>Waiting for an answer</h2>${outgoing.map(r => `
      <div class="req"><div class="who">@${esc(name(r.addressee))}</div><button class="btn small" data-can="${r.id}">Cancel</button></div>`).join('')}</section>` : ''}`;
  bindHeader();
  const fu = $('#fu');
  fu.addEventListener('keydown', e => { if (e.key === 'Enter') $('#fsend').click(); });
  $('#fsend').onclick = () => addFriend(fu.value);
  $('#frefresh').onclick = loadFriends;
  $('#copyU').onclick = async () => {
    try { await navigator.clipboard.writeText(profile.username); toast('Username copied.'); }
    catch (e) { toast(`Your username: <b>@${esc(profile.username)}</b>`); }
  };
  document.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => acceptFriend(b.dataset.acc));
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => removeFriendship(b.dataset.dec, 'Request declined.'));
  document.querySelectorAll('[data-can]').forEach(b => b.onclick = () => removeFriendship(b.dataset.can, 'Request cancelled.'));
  document.querySelectorAll('[data-unf]').forEach(b => b.onclick = () => {
    const r = friends.rows.find(x => x.id === b.dataset.unf); if (!r) return;
    const other = r.requester === me ? r.addressee : r.requester;
    confirmSheet(`Remove @${esc(name(other))}?`, "You'll stop seeing each other's pets. You can add each other again later.", 'Remove', () => removeFriendship(r.id, 'Friend removed.'));
  });
}
async function addFriend(raw) {
  const err = $('#ferr'), okEl = $('#fok'); err.textContent = ''; okEl.textContent = '';
  const u = raw.trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(u)) { err.textContent = 'Usernames are 3–20 lowercase letters, numbers or _.'; return; }
  if (u === profile.username) { err.textContent = "That's you!"; return; }
  $('#fsend').disabled = true;
  const { data: p, error } = await sb.from('profiles').select('id,username').eq('username', u).maybeSingle();
  if (error) { $('#fsend').disabled = false; err.textContent = "Couldn't search right now. Try again."; return; }
  if (!p) { $('#fsend').disabled = false; err.textContent = `No runner called @${u}. Check the spelling.`; return; }
  const ex = friends.rows.find(r => r.requester === p.id || r.addressee === p.id);
  if (ex) {
    $('#fsend').disabled = false;
    if (ex.status === 'accepted') { err.textContent = `You're already friends with @${u}.`; return; }
    if (ex.requester === profile.id) { err.textContent = `You already sent @${u} a request.`; return; }
    return acceptFriend(ex.id);
  }
  const { error: e2 } = await sb.from('friendships').insert({ requester: profile.id, addressee: p.id });
  if (e2) {
    if (e2.code === '23505') { await loadFriends(); toast(`You and @${esc(u)} already have a request between you. Check your requests.`); return; }
    $('#fsend').disabled = false; err.textContent = "Couldn't send the request. Try again."; return;
  }
  friends.profiles[p.id] = p;
  await loadFriends();
  toast(`Request sent to <b>@${esc(u)}</b>. You'll see their pet once they accept.`);
}
async function acceptFriend(id) {
  const { error } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', id);
  if (error) { toast("Couldn't accept. Try again."); return; }
  await loadFriends();
  const r = friends.rows.find(x => x.id === id);
  toast(r ? `You're now friends with <b>@${esc((friends.profiles[r.requester] || {}).username || '')}</b>.` : 'Request accepted.');
}
async function removeFriendship(id, msg) {
  const { error } = await sb.from('friendships').delete().eq('id', id);
  if (error) { toast("Couldn't do that. Try again."); return; }
  await loadFriends(); toast(msg);
}

/* ============ add run ============ */
function openAddRun() {
  openSheet(`<h3>Log a run</h3>
    <div class="grid2">
      <div class="field" style="margin-top:0"><label for="rk">Distance (km)</label><input id="rk" class="text mono" inputmode="decimal" placeholder="5.0" autocomplete="off"></div>
      <div class="field" style="margin-top:0"><label for="rd">Time (min) <span class="muted small">optional</span></label><input id="rd" class="text mono" inputmode="numeric" placeholder="28" autocomplete="off"></div>
    </div>
    <div class="field"><label for="rt">When</label><input id="rt" type="datetime-local" class="text" value="${localInputValue(now())}"></div>
    <div class="err" id="rerr"></div>
    <div class="grid2" style="margin-top:8px"><button class="btn" id="rc">Cancel</button><button class="btn primary" id="rs">Feed ${esc(S.pet.name)}</button></div>`,
    el => {
      const k = el.querySelector('#rk'); setTimeout(() => k.focus(), 50);
      el.querySelector('#rc').onclick = closeSheet;
      el.querySelector('#rs').onclick = async () => {
        const km = parseFloat(k.value.replace(',', '.'));
        const durRaw = el.querySelector('#rd').value.replace(',', '.').trim();
        const dur = durRaw ? parseFloat(durRaw) : null;
        const when = new Date(el.querySelector('#rt').value).getTime();
        const err = el.querySelector('#rerr');
        if (!(km > 0) || km > 400) { err.textContent = 'Enter a distance between 0 and 400 km.'; return; }
        if (durRaw && !(dur > 0)) { err.textContent = 'Time should be a number of minutes.'; return; }
        if (isNaN(when)) { err.textContent = 'Pick a date and time.'; return; }
        if (when > now() + 60000) { err.textContent = "That's in the future."; return; }
        const run = { id: newId(), date: when, km: Math.round(km * 100) / 100, durMin: dur, source: 'manual' };
        S.runs.push(run);
        closeSheet(); render();
        if (when >= S.pet.createdAt) feedFx(km);
        else toast(`Saved. That run is from before ${esc(S.pet.name)} hatched, so it doesn't count as food.`);
        await persistAddRuns([run]);
      };
      el.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#rs').click(); }));
    });
}

/* ============ import ============ */
function isDup(a) { return S.runs.some(r => Math.abs(r.date - a.date) < 2 * 60000 && Math.abs(r.km - a.km) < 0.05); }
async function handleFiles(files) {
  if (!S || !S.pet) return;
  const added = []; let dup = 0, notRun = 0, failed = 0;
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      let acts;
      if (ext === 'fit') acts = parseFIT(await file.arrayBuffer());
      else if (ext === 'tcx') acts = parseTCX(await file.text());
      else if (ext === 'gpx') acts = parseGPX(await file.text());
      else { failed++; continue; }
      if (!acts.length) { failed++; continue; }
      for (const a of acts) {
        if (!a.isRun) { notRun++; continue; }
        if (!(a.km > 0.01) || a.km > 400) { failed++; continue; }
        a.km = Math.round(a.km * 100) / 100;
        if (isDup(a)) { dup++; continue; }
        const r = { id: newId(), date: a.date, km: a.km, durMin: a.durMin ? Math.round(a.durMin * 10) / 10 : null, source: 'coros' };
        S.runs.push(r); added.push(r);
      }
    } catch (e) { failed++; }
  }
  render();
  const fed = added.filter(r => r.date >= S.pet.createdAt && r.date <= now());
  const fedKm = fed.reduce((s, r) => s + r.km, 0);
  if (fedKm) feedFx(fedKm);
  const parts = [];
  if (added.length) parts.push(`<b>Added ${added.length} run${added.length > 1 ? 's' : ''}</b> (${fmtKm(added.reduce((s, r) => s + r.km, 0))} km).`);
  else parts.push('<b>No new runs added.</b>');
  if (added.length - fed.length > 0) parts.push(`${added.length - fed.length} from before ${esc(S.pet.name)} hatched (no food).`);
  if (dup) parts.push(`${dup} already in your log.`);
  if (notRun) parts.push(notRun === 1 ? `1 activity wasn't a run.` : `${notRun} activities weren't runs.`);
  if (failed) parts.push(`${failed} file${failed > 1 ? 's' : ''} couldn't be read.`);
  toast(parts.join(' '), 6000);
  if (added.length) await persistAddRuns(added);
}

/* ============ render ============ */
const isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };
function render() {
  if (screen === 'boot') return renderBoot();
  if (screen === 'error') return renderError();
  if (screen === 'auth') return renderAuth();
  if (screen === 'username') return renderUsername();
  if (draft) return renderCreator(!!(S && S.pet));
  if (!S || !S.pet) { draft = newDraft(); return renderCreator(false); }
  if (tab === 'friends' && mode === 'cloud') return renderFriends();
  return renderPet();
}

// Hunger keeps ticking: redraw every minute, refresh friends every 5 minutes.
setInterval(() => {
  if (screen !== 'app' || draft || !S || !S.pet || sheetOpen() || isTyping()) return;
  const d = document.querySelector('details.settings'); const open = d && d.open;
  render();
  if (open) document.querySelector('details.settings').open = true;
}, 60000);
setInterval(() => { if (mode === 'cloud' && screen === 'app') loadFriends(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && mode === 'cloud' && screen === 'app') loadFriends(); });

boot();
