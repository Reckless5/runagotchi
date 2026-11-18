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
const SUPABASE_LIB = 'vendor/supabase.js'; // self-hosted, so no visitor data goes to a CDN

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
let settingsOpen = false;   // keep the Settings section open across re-renders
let authMode = 'login';
let friends = { loaded: false, loading: false, error: false, rows: [], profiles: {}, pets: {} };
let challenges = { loaded: false, loading: false, error: false, list: [], profiles: {} };
let watches = { loaded: false, enabled: {}, links: {}, setup: true };
let buddies = { loaded: false, mine: [], week: [] }, buddyPairs = new Set();
let messages = {}; // user id -> their latest chat bubble
const watchReturn = (() => { const q = new URLSearchParams(location.search); return q.get('watch') ? { provider: q.get('watch'), status: q.get('status'), reason: q.get('reason') } : null; })();
if (watchReturn) history.replaceState(null, '', location.pathname);
// Invite links look like …/?invite=CODE. The code is kept for this tab until the account exists.
const INVITE_KEY = 'runagotchi.invite';
let invite = (() => {
  const q = new URLSearchParams(location.search), c = (q.get('invite') || '').trim();
  if (c) { try { sessionStorage.setItem(INVITE_KEY, c); } catch (e) {} history.replaceState(null, '', location.pathname); }
  try { return c || sessionStorage.getItem(INVITE_KEY) || ''; } catch (e) { return c; }
})();
let inviteState = invite ? 'checking' : 'none'; // none | checking | ok | bad
let invites = { loaded: false, list: [] };       // admins: invite links they made
if (invite) authMode = 'signup';
const clearInvite = () => { invite = ''; inviteState = 'none'; try { sessionStorage.removeItem(INVITE_KEY); } catch (e) {} };
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
  // Test accounts: "at debugAt the pet had debugFood food"; hunger carries on from there.
  const ov = p.debugAt != null && p.debugFood != null;
  if (ov) {
    fedKm = st.runs.filter(r => r.date >= p.createdAt && r.date < p.debugAt).reduce((a, r) => a + r.km, 0);
    t = p.debugAt; f = Math.max(0, Math.min(MAX_FOOD, p.debugFood)); if (f === 0) zeroAt = t;
  }
  const from = ov ? p.debugAt : p.createdAt;
  const decay = to => {
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
  // Sick or injured: hunger (and the fainting countdown) is paused.
  const rests = restPeriodsOf(p);
  const adv = to => {
    if (to <= t) return;
    for (const [a, b] of rests) {
      if (b <= t || a >= to) continue;
      if (a > t) decay(a);
      const end = Math.min(b, to);
      if (!dead && f === 0 && zeroAt !== null) zeroAt += end - t;
      t = end;
      if (t >= to) return;
    }
    decay(to);
  };
  const runs = st.runs.filter(r => r.date >= from && r.date <= tNow).sort((a, b) => a.date - b.date);
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
function restPeriodsOf(p) {
  const list = (p.restPeriods || []).filter(r => r[1] > r[0]);
  if (p.condition && p.conditionSince) list.push([p.conditionSince, Infinity]);
  return list.sort((a, b) => a[0] - b[0]);
}
// A friend's pet: continue the countdown from the snapshot their app saved.
function simulateSnapshot(row, tNow) {
  const decayH = DIFF[row.difficulty].km * FOOD_PER_KM / 7 / 24;
  const t0 = Date.parse(row.snapshot_at);
  // A sick or injured pet doesn't get hungrier.
  if (row.condition && row.condition_since) tNow = Math.max(t0, Math.min(tNow, Date.parse(row.condition_since)));
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
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (x, s) => (x >> s) & 255, m = s => Math.round(ch(pa, s) * (1 - t) + ch(pb, s) * t);
  return '#' + [m(16), m(8), m(0)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = v => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return '#' + [m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function petSVG(p, mood, stage, id, run = false) {
  const sh = SHAPES[p.shape] || SHAPES.blob;
  const dead = mood === 'dead';
  const cond = dead ? null : (p.condition || null); // 'sick' | 'injured'
  const baseCol = COLORS[p.color] || COLORS.tangerine;
  const col = dead ? '#d6d6d0' : cond === 'sick' ? mixHex(baseCol, '#b5d68a', 0.45) : baseCol;
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
  if (cond === 'sick') { // droopy eyes, flushed cheeks, thermometer, sweat
    eyes = [L, R].map(x => `<path d="M${x - 8} ${ey - 1}h16" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/><path d="M${x - 6} ${ey}q6 6 12 0" fill="${ink}"/>`).join('');
    mouth = `<ellipse cx="96" cy="${ey + 19}" rx="5" ry="3.5" fill="${ink}"/><g transform="rotate(-24 98 ${ey + 19})"><rect x="98" y="${ey + 17}" width="34" height="5" rx="2.5" fill="#f4f4f4" stroke="#9aa" stroke-width="1"/><rect x="99" y="${ey + 18}" width="16" height="3" rx="1.5" fill="#e8403a"/><circle cx="133" cy="${ey + 19.5}" r="4" fill="#e8403a"/></g>`;
    extra = `<ellipse cx="${L - 9}" cy="${ey + 12}" rx="9" ry="5.5" fill="#ff5a5a" opacity=".55"/><ellipse cx="${R + 9}" cy="${ey + 12}" rx="9" ry="5.5" fill="#ff5a5a" opacity=".55"/><path d="M${L - 20} ${ey - 22}q-6 10 0 13q6 -3 0 -13z" fill="#6fb6ff"/>`;
  }
  if (cond === 'injured') { // pained squint, small frown, plaster on the head, bandaged foot
    eyes = `<path d="M${L - 7} ${ey - 6}l10 6l-10 6" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M${R + 7} ${ey - 6}l-10 6l10 6" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    mouth = `<path d="M91 ${ey + 21}q9 -8 18 0" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`;
    extra = `<g transform="translate(${100 - sh.ex - 4} ${sh.top + 18}) rotate(-20)"><rect x="-15" y="-5" width="30" height="10" rx="5" fill="#f2c79b" stroke="#d9a877" stroke-width="1"/><rect x="-5" y="-15" width="10" height="30" rx="5" fill="#f2c79b" stroke="#d9a877" stroke-width="1"/><rect x="-4" y="-4" width="8" height="8" rx="1.5" fill="#e6b689"/></g>`;
  }
  let acc = '';
  if (p.acc === 'cap') acc = `<path d="M${100 - 34} ${sh.top + 10}q34 -34 68 0z" fill="#2d4f9e"/><path d="M${100 + 30} ${sh.top + 8}q26 2 30 10q-16 2 -32 -2z" fill="#1f3a78"/><circle cx="100" cy="${sh.top - 7}" r="4" fill="#fff"/>`;
  if (p.acc === 'sprout') acc = `<path d="M100 ${sh.top + 2}v-18" stroke="#3f8f4f" stroke-width="4" stroke-linecap="round"/><path d="M100 ${sh.top - 14}q-18 -12 -24 2q14 8 24 -2z" fill="#5fbf6f"/><path d="M100 ${sh.top - 16}q16 -14 24 -2q-12 10 -24 2z" fill="#4caf5f"/>`;
  if (p.acc === 'bow') acc = `<g transform="translate(${100 + 26} ${sh.top + 10}) rotate(18)"><path d="M0 0l-16 -10v20z" fill="#ff4f8b"/><path d="M0 0l16 -10v20z" fill="#ff4f8b"/><circle r="5" fill="#e0306f"/></g>`;
  const running = run && mood !== 'dead' && mood !== 'fainting' && !p.condition;
  const feet = dead ? '' : cond === 'injured'
    ? `<g class="fl"><ellipse cx="78" cy="175" rx="15" ry="8" fill="#fbfbf7" stroke="#cfcfc4" stroke-width="1.5"/><path d="M66 172h24M65 177h26" stroke="#d8d8cc" stroke-width="1.5"/></g><ellipse class="fr" cx="122" cy="175" rx="14" ry="7" fill="${dark}"/>`
    : `<ellipse class="fl" cx="78" cy="175" rx="14" ry="7" fill="${dark}"/><ellipse class="fr" cx="122" cy="175" rx="14" ry="7" fill="${dark}"/>`;
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><clipPath id="${clip}"><path d="${sh.d}"/></clipPath></defs>
    ${dead ? '' : '<ellipse cx="100" cy="182" rx="56" ry="6" fill="rgba(0,0,0,.13)"/>'}
    <g transform="translate(100 180) scale(${scale}) translate(-100 -180)">
      <g class="pet-anim ${running ? 'm-run' : cond ? 'm-rest' : 'm-' + mood}">
        ${feet}
        <path d="${sh.d}" fill="${col}"/>
        <g clip-path="url(#${clip})">${pattern}${band}<path d="${sh.d}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="10" transform="translate(-4 -6)"/></g>
        <path d="${sh.d}" fill="none" stroke="${dark}" stroke-width="3"/>
        ${extra}${eyes}${mouth}${acc}
      </g>
    </g>
  </svg>`;
}

/* ============ storage ============ */
function loadLocal() { try { const t = localStorage.getItem(LS_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
function clearLocal() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }
const isGuest = () => { try { return localStorage.getItem(LS_GUEST) === '1'; } catch (e) { return false; } };
const setGuest = v => { try { v ? localStorage.setItem(LS_GUEST, '1') : localStorage.removeItem(LS_GUEST); } catch (e) {} };

const rowToPet = r => ({ name: r.name, shape: r.shape, color: r.color, pattern: r.pattern, acc: r.acc, difficulty: r.difficulty, createdAt: Date.parse(r.born_at),
  debugFood: r.debug_food == null ? null : Number(r.debug_food), debugAt: r.debug_at ? Date.parse(r.debug_at) : null,
  condition: r.condition || null, conditionSince: r.condition_since ? Date.parse(r.condition_since) : null,
  restPeriods: Array.isArray(r.rest_periods) ? r.rest_periods.map(x => [Date.parse(x[0]), Date.parse(x[1])]).filter(x => !isNaN(x[0]) && !isNaN(x[1])) : [] });
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
  const row = { user_id: profile.id, name: p.name, shape: p.shape, color: p.color, pattern: p.pattern, acc: p.acc, difficulty: p.difficulty,
    born_at: new Date(p.createdAt).toISOString(), ...snapshotRow() };
  // Only send the sick/injured fields once they're used, so older databases keep working.
  if (p.condition || (p.restPeriods && p.restPeriods.length)) Object.assign(row, {
    condition: p.condition || null, condition_since: p.conditionSince ? new Date(p.conditionSince).toISOString() : null,
    rest_periods: (p.restPeriods || []).map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]),
  });
  return row;
}
async function cloud(op, what) {
  const { error } = await op;
  if (error) {
    console.error(what, error);
    toast(/condition|rest_periods/.test(error.message || '') ? 'Almost: run supabase/009_condition.sql in Supabase first.' : `Couldn't save (${esc(what)}). Check your connection and try again.`);
    return false;
  }
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
  if (await cloud(sb.from('runs').insert(runs.map(runToRow)), 'runs')) { await pushSnapshot(); loadChallenges(); }
}
async function persistDeleteRun(id) {
  if (mode === 'local') return saveLocal();
  if (await cloud(sb.from('runs').delete().eq('id', id), 'run')) { await pushSnapshot(); loadChallenges(); }
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
      await new Promise((ok, fail) => { const el = document.createElement('script'); el.src = SUPABASE_LIB; el.onload = ok; el.onerror = fail; document.head.appendChild(el); });
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
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
  challenges = { loaded: false, loading: false, error: false, list: [], profiles: {} };
  watches = { loaded: false, enabled: {}, links: {}, setup: true };
  buddies = { loaded: false, mine: [], week: [] }; buddyPairs = new Set(); messages = {};
  invites = { loaded: false, list: [] };
  settingsOpen = false;
  profile = null; S = null; devOffset = 0;
  if (!uid) {
    if (isGuest()) return startLocal();
    authMode = invite ? 'signup' : 'login'; screen = 'auth'; return render();
  }
  setGuest(false);
  screen = 'boot'; render();
  const { data: prof, error } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
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
  loadChallenges();
  loadWatches();
  loadBuddies();
  loadMessages();
  if (watchReturn) showWatchReturn();
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
async function checkInvite() {
  if (!invite || inviteState !== 'checking') return;
  try {
    const { data, error } = await sb.rpc('invite_ok', { p_code: invite });
    inviteState = error ? 'ok' : (data ? 'ok' : 'bad'); // if the check fails, let sign-up itself decide
  } catch (e) { inviteState = 'ok'; }
  if (screen === 'auth') renderAuth();
}
function renderAuth() {
  if (!invite && authMode === 'signup') authMode = 'login';
  const signup = authMode === 'signup';
  if (invite && inviteState === 'checking') checkInvite();
  const badInvite = signup && inviteState === 'bad';
  $('#app').innerHTML = `
    <div class="auth">
      <header class="top"><div class="brand">Run<span>agotchi</span></div></header>
      <div class="mini">${petSVG(SAMPLE_PET, 'happy', 'grown', 'auth')}</div>
      <div class="hero"><h1>${signup ? "You're invited!" : 'Welcome back'}</h1><p>${signup ? 'Create your account and hatch a pet that lives on the kilometers you run.' : 'A pet that lives on the kilometers you run.'}</p></div>
      <section class="card">
        ${invite ? `<div class="seg"><button data-m="login" class="${signup ? '' : 'on'}">Log in</button><button data-m="signup" class="${signup ? 'on' : ''}">Sign up</button></div>` : ''}
        ${badInvite ? `<div class="err" style="margin-top:8px">This invite link has already been used or isn't valid. Ask for a new one.</div>` : ''}
        <form id="af" novalidate>
          <div class="field" style="margin-top:12px"><label for="em">Email</label><input id="em" type="email" class="text" autocomplete="email" required></div>
          <div class="field" style="margin-top:12px"><label for="pw">Password</label><input id="pw" type="password" class="text" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required>
            ${signup ? '<div class="small muted" style="margin-top:6px">At least 6 characters.</div>' : ''}</div>
          <div class="err" id="aerr"></div><div class="ok" id="aok"></div>
          <button class="btn primary" id="asub" style="width:100%" ${badInvite ? 'disabled' : ''}>${signup ? 'Create account' : 'Log in'}</button>
        </form>
        ${signup ? '' : '<div class="center"><button class="linkbtn" id="forgot">Forgot password?</button></div>'}
        ${invite ? '' : '<p class="small muted center" style="margin:10px 0 0">Runagotchi is invite-only while it\'s being built. New here? Ask a friend who uses it for an invite link.</p>'}
      </section>
      <div class="center"><button class="linkbtn" id="guest" style="color:var(--muted)">Continue without an account</button>
        <div class="small muted">Your pet is saved on this device only, and you can't add friends.</div>
        <div class="small" style="margin-top:14px"><a href="privacy.html" style="color:var(--muted)">Privacy policy</a></div></div>
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
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname, data: { invite } } });
      btn.disabled = false;
      if (error) {
        // The database refuses accounts without a valid invite; Supabase reports that as a database error.
        if (/database error|invite/i.test(error.message)) { inviteState = 'bad'; return renderAuth(); }
        err.textContent = error.message; return;
      }
      clearInvite();
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
  const invites = mode === 'cloud' ? challenges.list.filter(c => myStatus(c) === 'invited' && c.end > Date.now()).length : 0;
  return `<header class="top"><div class="brand">Run<span>agotchi</span></div>${right}</header>
    ${mode === 'cloud' ? `<nav class="bottomnav" aria-label="Main">${[
      ['pet', 'My pet', NAV_ICONS.pet, 0],
      ['run', 'Run', NAV_ICONS.run, 0],
      ['challenge', 'Challenge', NAV_ICONS.challenge, invites],
      ['friends', 'Friends', NAV_ICONS.friends, incoming],
    ].map(([id, label, icon, n]) => `<button data-tab="${id}" class="${tab === id ? 'on' : ''}" ${tab === id ? 'aria-current="page"' : ''}>
      <span class="ni">${icon}${n ? `<span class="pill">${n}</span>` : ''}</span><span class="nl">${label}</span></button>`).join('')}</nav>` : ''}`;
}
const NAV_ICONS = {
  pet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c4.6 0 7.5 4.6 7.5 10s-3.2 9-7.5 9-7.5-3.6-7.5-9 2.9-10 7.5-10z"/><rect x="8" y="7.5" width="8" height="6.5" rx="1.6"/><circle cx="10.6" cy="10.4" r=".5" class="dot"/><circle cx="13.4" cy="10.4" r=".5" class="dot"/><circle cx="9" cy="17.3" r="1" class="dot"/><circle cx="12" cy="18.2" r="1" class="dot"/><circle cx="15" cy="17.3" r="1" class="dot"/></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="15" cy="4.5" r="2"/><path d="M5 21l4-6 3.5 2.5V22M8 11l3.5-3.5 3 2.5 3 1M11.5 7.5l1 5.5-3 2.5M14.5 10l-1.5 4.5 3 2.5"/></svg>',
  challenge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5A3.5 3.5 0 0 1 16.5 11M12 14v3.5M8.5 21h7M9.5 17.5h5"/></svg>',
  friends: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.8-.4 5 1.8 5 4.8"/></svg>',
};
function bindHeader() {
  document.body.classList.toggle('hasnav', mode === 'cloud');
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); if (tab !== 'pet') loadFriends(); if (tab === 'challenge') loadChallenges(); if (tab === 'run' || tab === 'friends') loadBuddies(); if (tab === 'run') loadMessages(); });
}
function statusLine(sim, p) {
  const n = `<b>${esc(p.name)}</b>`;
  const m = moodOf(sim);
  if (p.condition && m !== 'dead') return { cls: '', html: `${n} is ${p.condition === 'sick' ? 'sick' : 'injured'} and resting. <b>Hunger is paused</b> until you're better.` };
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
    <div class="cond" role="group" aria-label="How are you?">
      ${[['', '💪 Healthy'], ['sick', '🤒 Sick'], ['injured', '🩹 Injured']].map(([k, l]) => `<button class="${(p.condition || '') === k ? 'on' : ''}" data-cond="${k}">${l}</button>`).join('')}
    </div>

    <div class="stats">
      <div class="stat"><div class="v">${Math.round(sim.f)}</div><div class="k">food / 100</div></div>
      <div class="stat"><div class="v">${weekKm >= 100 ? Math.round(weekKm) : weekKm.toFixed(1)}</div><div class="k">km this week · goal ${goal}</div></div>
      <div class="stat"><div class="v">${sim.fedKm >= 100 ? Math.round(sim.fedKm) : sim.fedKm.toFixed(1)}</div><div class="k">km fed total</div></div>
    </div>

    <div class="actions single">
      <button class="btn primary" id="addRun">+ Log a run</button>
    </div>

    ${debugCard()}
    ${incomingCard()}
    <section class="card">
      <h2>Runs <span class="small muted">${sim.lastFeed ? 'last fed ' + fmtAgo(sim.lastFeed) : ''}</span></h2>
      ${shown.length ? `<ul class="runs">${shown.map(r => `
        <li>
          <div class="km">${fmtKm(r.km)} km</div>
          <div class="meta">${fmtDate(r.date)}${WATCH_NAMES[r.source] ? `<span class="badge watch">${WATCH_NAMES[r.source]}</span>` : ''}${r.date < p.createdAt ? '<span class="badge pre">before hatch</span>' : ''}${r.date > t ? '<span class="badge pre">future</span>' : ''}<br>${[r.durMin ? Math.round(r.durMin) + ' min' : '', pace(r)].filter(Boolean).join(' · ')}${tagsForRun(r.id).length ? `<span class="with">🤝 with ${tagsForRun(r.id).map(id => '@' + esc(unameOf(id))).join(', ')}</span>` : ''}</div>
          ${acceptedFriendIds().length ? `<button class="x bud" data-bud="${r.id}" aria-label="Who ran with you" title="Who ran with you?">👥</button>` : ''}
          <button class="x" data-del="${r.id}" aria-label="Delete run">×</button>
        </li>`).join('')}</ul>
        ${sorted.length > 6 ? `<button class="btn small ghost" id="moreRuns" style="margin-top:6px">${showAllRuns ? 'Show fewer' : 'Show all ' + sorted.length + ' runs'}</button>` : ''}`
      : `<div class="empty">No runs yet. Log one to feed ${esc(p.name)}.</div>`}
    </section>

    <section class="card">
      <details class="settings" ${settingsOpen ? 'open' : ''}>
        <summary>Settings</summary>
        ${account}
        ${mode === 'cloud' ? watchesCard() : ''}
        <div class="row" style="margin-top:14px"><button class="btn small" id="editPet">Edit ${esc(p.name)}</button><span class="small muted">Appetite: ${DIFF[p.difficulty].label} (~${goal} km/week)</span></div>
        ${mode === 'local' || isDebug() ? `
        <div class="row" style="margin-top:14px"><span class="small"><b>Time machine</b> <span class="muted">(for testing hunger)</span></span></div>
        <div class="row" style="margin-top:6px">
          <button class="btn small" data-tm="12">+12 h</button><button class="btn small" data-tm="24">+1 day</button><button class="btn small" data-tm="72">+3 days</button>
          ${devOffset ? '<button class="btn small" data-tm="0">Back to now</button>' : ''}
        </div>` : ''}
        <div class="row" style="margin-top:14px"><button class="btn small danger" id="restart">Start over with a new pet</button></div>
        <div class="row" style="margin-top:14px"><a class="small" href="privacy.html" style="color:var(--muted)">Privacy policy</a>${mode === 'cloud' ? `<span class="small muted">· To delete your account, email <a href="mailto:andeleutgeb@gmail.com" style="color:var(--muted)">andeleutgeb@gmail.com</a></span>` : ''}</div>
        <p class="small muted" style="margin:10px 0 0">Born ${fmtDate(p.createdAt)}${sim.revives ? ' · revived ' + sim.revives + '×' : ''}. Runs from before the hatch date are kept but don't count as food.</p>
      </details>
    </section>`;
  bindHeader();
  const sd = document.querySelector('details.settings');
  if (sd) sd.addEventListener('toggle', () => { settingsOpen = sd.open; });
  $('#addRun').onclick = openAddRun;
  document.querySelectorAll('[data-cond]').forEach(b => b.onclick = () => setCondition(b.dataset.cond || null));
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const r = S.runs.find(x => x.id === b.dataset.del); if (!r) return;
    confirmSheet('Delete this run?', `${fmtKm(r.km)} km on ${fmtDate(r.date)}. ${esc(p.name)} will un-eat it.`, 'Delete', () => {
      S.runs = S.runs.filter(x => x.id !== r.id); render(); persistDeleteRun(r.id);
    });
  });
  document.querySelectorAll('[data-bud]').forEach(b => b.onclick = () => openRunBuddies(b.dataset.bud));
  bindIncoming();
  bindDebug();
  if ($('#moreRuns')) $('#moreRuns').onclick = () => { showAllRuns = !showAllRuns; render(); };
  $('#editPet').onclick = () => { draft = { ...S.pet }; render(); window.scrollTo(0, 0); };
  document.querySelectorAll('[data-tm]').forEach(b => b.onclick = () => {
    const h = +b.dataset.tm; devOffset = h ? devOffset + h * H : 0; render();
    const d = document.querySelector('details.settings'); if (d) d.open = true;
  });
  if ($('#logout')) $('#logout').onclick = () => sb.auth.signOut();
  bindWatches();
  if ($('#toAuth')) $('#toAuth').onclick = () => { setGuest(false); authMode = invite ? 'signup' : 'login'; screen = 'auth'; render(); window.scrollTo(0, 0); };
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
      ids.length ? sb.from('profiles').select('*').in('id', ids) : { data: [] },
      acceptedIds.length ? sb.from('pets').select('*').in('user_id', acceptedIds) : { data: [] }
    ]);
    if (pr.error || pe.error) throw (pr.error || pe.error);
    friends = { loaded: true, loading: false, error: false, rows,
      profiles: Object.fromEntries(pr.data.map(p => [p.id, p])), pets: Object.fromEntries(pe.data.map(p => [p.user_id, p])) };
  } catch (e) { console.error(e); friends.loading = false; friends.error = true; }
  if (screen === 'app' && !draft && !sheetOpen() && !isTyping()) {
    if (tab === 'run') { const sig = runSignature(); if (sig === lastRunSig) return; }
    render();
  }
}
function friendStatus(sim, row) {
  const m = moodOf(sim);
  if (row.condition && m !== 'dead') return { bad: false, txt: row.condition === 'sick' ? '🤒 Sick, resting' : '🩹 Injured, resting' };
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
      ${areBuddies(me, id) ? '<div class="budbadge">🤝 Ran together this week</div>' : ''}
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
    ${invitesCard()}
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
  bindInvites();
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


/* ============ run together ============ */
// Strength decides the running order: how full the pet is right now,
// plus a bonus for its level (long-term training).
const strengthOf = (sim, level) => sim.dead ? -1 : sim.f <= 0 ? 0 : Math.round(sim.f * 0.75 + Math.min(level, 25));
let lastRunSig = '';
function runners() {
  const list = [];
  if (S && S.pet) {
    const sim = simulate(S, Date.now()), level = levelOf(sim.fedKm);
    list.push({ key: 'me', me: true, pet: S.pet, user: profile.username, sim, level, stage: stageOf(sim.fedKm) });
  }
  const me = profile.id;
  for (const r of friends.rows.filter(r => r.status === 'accepted')) {
    const id = r.requester === me ? r.addressee : r.requester, row = friends.pets[id];
    if (!row) continue;
    list.push({ key: id, me: false, pet: row, user: (friends.profiles[id] || {}).username || '', sim: simulateSnapshot(row, Date.now()), level: row.level, stage: row.stage });
  }
  list.forEach(x => { x.mood = moodOf(x.sim); x.strength = strengthOf(x.sim, x.level); });
  return list.sort((a, b) => b.strength - a.strength || b.level - a.level || a.pet.name.localeCompare(b.pet.name));
}
const runSignature = () => runners().map(x => x.key + ':' + x.mood + ':' + x.strength + ':' + (x.pet.condition || '')).join('|') + (friends.loaded ? '' : '…') + [...buddyPairs].sort().join(',') + JSON.stringify(messages);

const svgUri = s => `url('data:image/svg+xml,${encodeURIComponent(s)}')`;
function sceneLayers(night) {
  const c = night
    ? { cloud: '#8a93b8', far: '#3b4370', near: '#2f5a55', tree: '#1f4a3c', trunk: '#3a2c22', grass: '#2f6b47' }
    : { cloud: '#ffffff', far: '#a9b8d6', near: '#8cc49a', tree: '#4f9a62', trunk: '#8a5a3c', grass: '#6cbf6f' };
  const clouds = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><g fill="${c.cloud}" opacity=".9"><circle cx="70" cy="60" r="22"/><circle cx="98" cy="50" r="28"/><circle cx="130" cy="62" r="20"/><rect x="60" y="60" width="80" height="22" rx="11"/><circle cx="380" cy="34" r="16"/><circle cx="402" cy="26" r="20"/><circle cx="426" cy="36" r="14"/><rect x="372" y="34" width="62" height="16" rx="8"/></g></svg>`;
  const far = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="140"><path d="M0 140V90L80 50L150 85L230 30L320 80L400 55L480 95L560 40L650 85L730 60L800 90V140Z" fill="${c.far}"/><path d="M230 30L212 40L230 44L246 38ZM560 40L544 50L562 53L576 49Z" fill="#fff" opacity="${night ? .25 : .7}"/></svg>`;
  const near = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="110"><path d="M0 110V60Q75 20 150 55T300 50T450 45T600 60V110Z" fill="${c.near}"/></svg>`;
  const trees = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="110"><rect x="36" y="70" width="8" height="40" fill="${c.trunk}"/><circle cx="40" cy="58" r="26" fill="${c.tree}"/><rect x="146" y="78" width="6" height="32" fill="${c.trunk}"/><path d="M149 24L126 66H172ZM149 44L122 86H176Z" fill="${c.tree}"/><rect x="256" y="76" width="7" height="34" fill="${c.trunk}"/><circle cx="260" cy="64" r="20" fill="${c.tree}"/><circle cx="246" cy="76" r="14" fill="${c.tree}"/><circle cx="274" cy="76" r="14" fill="${c.tree}"/><ellipse cx="330" cy="104" rx="20" ry="10" fill="${c.tree}"/></svg>`;
  const track = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="14" fill="${c.grass}"/><path d="M10 14l4-7 4 7M70 14l3-6 3 6M120 14l4-8 4 8" fill="${c.grass}" stroke="${c.grass}"/><rect y="14" width="160" height="82" fill="${night ? '#7a3a30' : '#c8553d'}"/><rect y="16" width="160" height="2" fill="#fff" opacity=".8"/><rect y="94" width="160" height="2" fill="#fff" opacity=".8"/><rect x="0" y="54" width="40" height="3" fill="#fff" opacity=".85"/><rect x="80" y="54" width="40" height="3" fill="#fff" opacity=".85"/></svg>`;
  return `
    <div class="layer l-clouds" style="background-image:${svgUri(clouds)}"></div>
    <div class="layer l-far" style="background-image:${svgUri(far)}"></div>
    <div class="layer l-near" style="background-image:${svgUri(near)}"></div>
    <div class="layer l-trees" style="background-image:${svgUri(trees)}"></div>
    <div class="layer l-track" style="background-image:${svgUri(track)}"></div>`;
}
function skyFor(hour) {
  if (hour >= 21 || hour < 5) return { night: true, bg: 'linear-gradient(#141a3a, #2b3466 70%, #3d4479)', orb: '<div class="moon"></div><div class="stars"></div>' };
  if (hour < 8) return { night: false, bg: 'linear-gradient(#ffc9a8, #ffe3c4 60%, #fff1dc)', orb: '<div class="sun low"></div>' };
  if (hour >= 18) return { night: false, bg: 'linear-gradient(#ff9e7a, #ffc49a 55%, #ffe0b8)', orb: '<div class="sun low"></div>' };
  return { night: false, bg: 'linear-gradient(#7cc4ff, #bfe3ff 65%, #e6f5ff)', orb: '<div class="sun"></div>' };
}
function renderRun() {
  const everyone = runners();
  // Sick and injured pets ride in a cart; everyone else runs.
  const isRider = x => !!x.pet.condition && x.mood !== 'dead';
  const riders = everyone.filter(isRider), ranked = everyone.filter(x => !isRider(x));
  lastRunSig = runSignature();
  const n = ranked.length, N = everyone.length;
  const sky = skyFor(new Date().getHours());
  // Buddies who ran together this week form one group: the group runs where its
  // strongest member would, and its members run side by side.
  const idOf = x => x.me ? profile.id : x.key;
  const parent = ranked.map((_, i) => i);
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (areBuddies(idOf(ranked[i]), idOf(ranked[j]))) parent[root(j)] = root(i);
  // Inside a group, line pets up as a chain of real running pairs: start at a pet
  // with the fewest buddies and keep stepping to an unvisited buddy.
  const nb = i => ranked.map((_, j) => j).filter(j => j !== i && areBuddies(idOf(ranked[i]), idOf(ranked[j])));
  const order = [], done = new Set();
  ranked.forEach((_, i) => {
    const r = root(i); if (done.has(r)) return; done.add(r);
    const members = ranked.map((__, j) => j).filter(j => root(j) === r);
    const left = new Set(members);
    let cur = members.slice().sort((x, y) => nb(x).length - nb(y).length || x - y)[0];
    while (cur !== undefined) {
      order.push(cur); left.delete(cur);
      const next = nb(cur).filter(j => left.has(j)).sort((x, y) => nb(x).filter(k => left.has(k)).length - nb(y).filter(k => left.has(k)).length || x - y)[0];
      cur = next !== undefined ? next : [...left][0];
    }
  });
  const list = order.map(i => ranked[i]), group = order.map(i => root(i));
  const LANES = [{ b: 44, z: 3, s: 1 }, { b: 70, z: 1, s: .86 }, { b: 20, z: 5, s: 1.08 }]; // middle, back, front
  const base = N > 8 ? 70 : N > 4 ? 84 : 100;
  // Pets with the same status run as a tight group; a new status starts a gap.
  const STEP = 1.4, GAP = 3.6, BUDDY = 1.2;
  const units = []; let u = 0, laneIdx = [], li = 0;
  list.forEach((x, i) => {
    if (i > 0) {
      const together = group[i] === group[i - 1], same = together || x.mood === list[i - 1].mood;
      u += together ? BUDDY : same ? STEP : GAP; li = same ? li + 1 : 0;
    }
    units.push(u); laneIdx.push(li);
  });
  // The cart trails the pack: keep room for it on the left so it stays on screen.
  const sceneW = Math.max(280, Math.min(480, ($('#app') && $('#app').clientWidth) || 420) - 32);
  const riderW = Math.round(base * 0.62), cartW = Math.round(riderW * 0.82 * riders.length + riderW * 0.35 + 22);
  const cartPct = riders.length ? cartW / sceneW * 100 : 0;
  const left = riders.length ? 3 + cartPct + 7 : 16, right = 84;
  const span = u, per = span ? Math.min((right - left) / span, 9) : 0; // % of scene width per unit
  const lead = (left + right) / 2 + span * per / 2;                    // keep the pack centred in its space
  const pos = i => lead - units[i] * per;
  const cartX = !riders.length ? null : n ? Math.max(2 + cartPct / 2, lead - span * per - 7 - cartPct / 2) : 50;
  // The cart rolls as long as at least one runner (not fainted or starved) is healthy.
  const pullers = riders.length ? list.map((x, i) => i).filter(i => !['dead', 'fainting'].includes(list[i].mood)) : [];
  const cartHtml = riders.length ? `<div class="cart ${pullers.length ? '' : 'parked'}" style="left:${cartX}%;width:${cartW}px;--rw:${riderW}px">
      <div class="riders">${riders.map(x => `<div class="rider">${petSVG(x.pet, x.mood, x.stage, 'c' + x.key.slice(0, 8))}</div>`).join('')}</div>
      <div class="box"></div><div class="handle"></div><span class="hitch"></span>
      <div class="wheel w1"><i></i></div><div class="wheel w2"><i></i></div>
    </div>
    <div class="tag cart-tag" style="left:${cartX}%;bottom:2px">${riders.map(x => `${x.pet.condition === 'sick' ? '🤒' : '🩹'} ${x.me ? '<b>You</b> · ' : ''}${esc(x.pet.name)}`).join(' · ')}</div>
    ${pullers.length ? '' : `<div class="scene-note cart-note">Waiting for a healthy friend to pull the cart</div>`}` : '';
  const label = x => x.mood === 'dead' ? 'starved' : x.mood === 'fainting' ? 'fainted' : x.mood === 'starving' ? 'starving' : x.mood === 'hungry' ? 'hungry' : x.mood === 'content' ? 'fine' : 'strong';
  const runnerHtml = list.map((x, i) => {
    const lane = LANES[laneIdx[i] % 3];
    const w = Math.round(base * lane.s);
    const spd = (0.75 - Math.max(0, x.strength) / 100 * 0.4).toFixed(2);
    return `<div class="runner ${x.me ? 'me' : ''} ${x.mood}" style="left:${pos(i)}%;bottom:${lane.b}px;width:${w}px;z-index:${lane.z + 10};--spd:${spd}s">
      ${x.mood !== 'dead' && x.mood !== 'fainting' && x.strength >= 70 ? '<div class="dust"><i></i><i></i><i></i></div>' : ''}
      ${petSVG(x.pet, x.mood, x.stage, 'r' + x.key.slice(0, 8), true)}
    </div>`;
  }).join('');
  // The friendship symbol between buddies running next to each other.
  const linkHtml = list.map((x, i) => {
    if (i === 0 || group[i] !== group[i - 1] || !areBuddies(idOf(x), idOf(list[i - 1]))) return '';
    const a = pos(i), b = pos(i - 1), la = LANES[laneIdx[i] % 3], lb = LANES[laneIdx[i - 1] % 3];
    const y = Math.max(la.b, lb.b) + 22; // just above both name tags
    return `<div class="blink" style="left:${a}%;width:${b - a}%;bottom:${y}px"><span>🤝</span></div>`;
  }).join('');
  // Chat bubbles above the pets; neighbours alternate heights so they overlap less.
  const bubbleHtml = list.map((x, i) => {
    const m = messages[idOf(x)]; if (!m) return '';
    // Above the back row, so a bubble never covers a pet running behind.
    const y = LANES[1].b + Math.round(base * LANES[1].s * 0.82);
    return `<div class="bubble ${x.me ? 'me' : ''}" style="left:${pos(i)}%;bottom:${y}px" title="${esc(fmtAgo(Date.parse(m.created_at), Date.now()))}"><span>${esc(m.body)}</span></div>`;
  }).join('') + riders.map(x => {
    const m = messages[idOf(x)]; if (!m) return '';
    return `<div class="bubble ${x.me ? 'me' : ''}" style="left:${cartX}%;bottom:${LANES[1].b + Math.round(base * LANES[1].s * 0.82)}px"><span>${esc(m.body)}</span></div>`;
  }).join('');
  // Name tags live on their own layer so no pet ever covers them.
  const tagHtml = list.map((x, i) => `<div class="tag ${x.me ? 'me' : ''}" style="left:${pos(i)}%;bottom:${LANES[laneIdx[i] % 3].b - 14}px">${x.me ? '<b>You</b> · ' : ''}${esc(x.pet.name)}</div>`).join('');
  const nameById = Object.fromEntries(everyone.map(x => [idOf(x), x.me ? 'you' : x.pet.name]));
  const rows = everyone.map((x, i) => {
    const bud = buddiesOf(idOf(x)).filter(id => nameById[id]).map(id => nameById[id]);
    return `
    <li class="${x.me ? 'me' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="who"><b>${esc(x.pet.name)}</b><span class="small muted">${x.me ? 'you' : '@' + esc(x.user)} · LV ${x.level}</span>${bud.length ? `<span class="small bud-note">🤝 with ${bud.map(esc).join(', ')}</span>` : ''}${messages[idOf(x)] ? `<span class="small msg-note">💬 ${esc(messages[idOf(x)].body)} <span class="muted">· ${fmtAgo(Date.parse(messages[idOf(x)].created_at), Date.now())}</span></span>` : ''}</span>
      <span class="str"><span class="sbar"><i style="width:${Math.max(0, x.strength)}%"></i></span><span class="small ${isRider(x) ? 'cond-note' : x.strength < 15 ? 'bad' : 'muted'}">${isRider(x) ? (x.pet.condition === 'sick' ? '🤒 sick' : '🩹 injured') : label(x)}</span></span>
    </li>`;
  }).join('');
  $('#app').innerHTML = `${header()}
    <div class="scene ${sky.night ? 'night' : ''}" style="background:${sky.bg}">
      ${sky.orb}
      ${sceneLayers(sky.night)}
      <button class="scene-title" id="renamePack2" aria-label="Rename your running group">${esc(packName())} <span>✏️</span></button>
      ${N ? runnerHtml + linkHtml + tagHtml + cartHtml + bubbleHtml : ''}
      ${N <= 1 ? `<div class="scene-note">${!friends.loaded && !friends.error ? 'Loading friends…' : 'Add friends to run together!'}</div>` : ''}
    </div>
    ${N ? `<form class="say" id="sayForm"><input id="say" class="text" maxlength="80" autocomplete="off" placeholder="Say something to your pack…"><button class="btn primary" id="saySend">Send</button></form>
      ${messages[profile.id] ? `<div class="small muted say-mine">Your bubble: “${esc(messages[profile.id].body)}” · ${fmtAgo(Date.parse(messages[profile.id].created_at), Date.now())} · <button class="linkbtn" id="sayClear">Remove</button></div>` : ''}` : ''}
    <p class="small muted center" style="margin:8px 0 14px">Strongest pets lead the pack, the weakest trail behind. Friends who ran together this week run side by side 🤝</p>
    ${N ? `<section class="card"><h2><span class="packname">${esc(packName())} <button class="linkbtn rename" id="renamePack" aria-label="Rename your running group">✏️</button></span><button class="btn small ghost" id="rrefresh">${friends.loading ? 'Loading…' : 'Refresh'}</button></h2><ol class="pack">${rows}</ol>
      ${N === 1 ? `<div class="empty">Only you so far. <button class="linkbtn" id="goFriends">Add friends</button></div>` : ''}</section>` : ''}`;
  bindHeader();
  if ($('#rrefresh')) $('#rrefresh').onclick = loadFriends;
  ['#renamePack', '#renamePack2'].forEach(sel => { if ($(sel)) $(sel).onclick = openRenamePack; });
  stackBubbles();
  if ($('#sayForm')) $('#sayForm').onsubmit = e => { e.preventDefault(); sendMessage($('#say').value); };
  if ($('#sayClear')) $('#sayClear').onclick = clearMessage;
  if ($('#goFriends')) $('#goFriends').onclick = () => { tab = 'friends'; render(); };
}


/* ============ challenges ============ */
const DURATIONS = [{ k: '1d', label: '1 day', days: 1 }, { k: '3d', label: '3 days', days: 3 }, { k: '1w', label: '1 week', days: 7 },
  { k: '2w', label: '2 weeks', days: 14 }, { k: '1m', label: '1 month', days: 30 }];
const DIST_PRESETS = [5, 10, 21.1, 42.2, 50, 100];
const myStatus = c => (c.members.find(m => m.user_id === profile.id) || {}).status;
const unameOf = id => id === profile.id ? profile.username : ((friends.profiles[id] || challenges.profiles[id] || {}).username || 'someone');
function durLabel(c) {
  const days = Math.round((c.end - c.start) / D);
  const d = DURATIONS.find(x => x.days === days);
  return d ? d.label : days + ' days';
}
const fmtDist = km => (Math.round(km * 10) / 10).toString().replace(/\.0$/, '');
// Turn a database error into something the user can act on.
function dbErrorText(e) {
  const m = (e && (e.message || '')) + ' ' + (e && e.code || '');
  if (/challenge/i.test(m) && /(schema cache|does not exist|PGRST20|42P01|42883)/i.test(m))
    return 'The challenge tables are missing in Supabase. Run supabase/002_challenges.sql in the SQL Editor.';
  if (/row-level security|42501/i.test(m)) return 'The database refused this (security rule). Details: ' + (e.message || e.code);
  return (e && e.message) ? 'Details: ' + e.message : 'Check your connection and try again.';
}

async function loadChallenges() {
  if (mode !== 'cloud' || challenges.loading) return;
  challenges.loading = true; challenges.error = false;
  if (tab === 'challenge') render();
  try {
    const [cr, mr, pr, chr] = await Promise.all([
      sb.from('challenges').select('id,creator,distance_km,starts_at,ends_at,created_at'),
      sb.from('challenge_members').select('challenge_id,user_id,status'),
      sb.rpc('challenge_progress_all'),
      sb.from('challenge_cheers').select('id,challenge_id,from_user,to_user,kind')
    ]);
    for (const r of [cr, mr, pr, chr]) if (r.error) throw r.error;
    const ids = [...new Set(mr.data.map(m => m.user_id).concat(cr.data.map(c => c.creator)))];
    const missing = ids.filter(id => id !== profile.id && !friends.profiles[id] && !challenges.profiles[id]);
    if (missing.length) {
      const { data, error } = await sb.from('profiles').select('id,username').in('id', missing);
      if (error) throw error;
      data.forEach(p => { challenges.profiles[p.id] = p; });
    }
    const list = cr.data.map(c => ({
      ...c, distance_km: Number(c.distance_km), start: Date.parse(c.starts_at), end: Date.parse(c.ends_at),
      members: mr.data.filter(m => m.challenge_id === c.id),
      km: Object.fromEntries(pr.data.filter(p => p.challenge_id === c.id).map(p => [p.user_id, Number(p.km)])),
      cheers: chr.data.filter(x => x.challenge_id === c.id)
    })).sort((a, b) => a.end - b.end);
    challenges = { ...challenges, loaded: true, loading: false, error: false, list };
  } catch (e) { console.error(e); challenges.loading = false; challenges.error = dbErrorText(e); }
  if (screen === 'app' && !draft && !sheetOpen() && !isTyping() && tab !== 'run') render();
}

// Ranking of everyone who joined, by share of the distance done.
function standings(c) {
  const joined = c.members.filter(m => m.status === 'joined').map(m => {
    const km = c.km[m.user_id] || 0;
    return { id: m.user_id, km, pct: km / c.distance_km * 100 };
  }).sort((a, b) => b.km - a.km || unameOf(a.id).localeCompare(unameOf(b.id)));
  const top = Math.max(1, Math.ceil(joined.length / 2));
  joined.forEach((x, i) => {
    x.rank = i + 1;
    // Leaders (top half, with some distance) get kudos; everyone behind gets encouragement.
    x.cheerKind = x.pct >= 100 || (i < top && x.km > 0) ? 'kudos' : 'encourage';
    x.kudos = c.cheers.filter(h => h.to_user === x.id && h.kind === 'kudos').length;
    x.enc = c.cheers.filter(h => h.to_user === x.id && h.kind === 'encourage').length;
  });
  return joined;
}
function avatar(id) {
  let p = null, mood = 'content', stage = 'grown';
  if (id === profile.id && S && S.pet) { const sim = simulate(S, Date.now()); p = S.pet; mood = moodOf(sim); stage = stageOf(sim.fedKm); }
  else if (friends.pets[id]) { p = friends.pets[id]; mood = moodOf(simulateSnapshot(p, Date.now())); stage = p.stage; }
  if (!p) return `<span class="av empty">${esc(unameOf(id).slice(0, 1).toUpperCase())}</span>`;
  if (mood === 'fainting') mood = 'starving';
  return `<span class="av">${petSVG(p, mood, stage === 'baby' ? 'kid' : stage, 'av' + id.slice(0, 6) + Math.random().toString(36).slice(2, 6))}</span>`;
}
function challengeCard(c) {
  const t = Date.now(), done = t >= c.end, me = profile.id, mine = myStatus(c);
  const rows = standings(c);
  const waiting = c.members.filter(m => m.status === 'invited');
  const left = done ? `ended ${fmtAgo(c.end, t)}` : `${fmtHours((c.end - t) / H)} left`;
  const rowHtml = rows.map(x => {
    const isMe = x.id === me;
    const given = c.cheers.find(h => h.from_user === me && h.to_user === x.id && h.kind === x.cheerKind);
    const btn = isMe || mine !== 'joined' ? '' :
      `<button class="cheer ${x.cheerKind} ${given ? 'sent' : ''}" data-cheer="${c.id}|${x.id}|${x.cheerKind}" ${given ? `data-undo="${given.id}"` : ''}>
        ${x.cheerKind === 'kudos' ? (given ? '👏 Sent' : '👏 Kudos') : (given ? '💪 Sent' : '💪 Cheer on')}</button>`;
    const got = [x.kudos ? `👏 ${x.kudos}` : '', x.enc ? `💪 ${x.enc}` : ''].filter(Boolean).join(' · ');
    return `<li class="${isMe ? 'me' : ''}">
      <span class="rk">${done && x.rank === 1 && x.km > 0 ? '🏆' : x.rank}</span>
      ${avatar(x.id)}
      <span class="body">
        <span class="line"><b>${isMe ? 'You' : '@' + esc(unameOf(x.id))}</b><span class="pct ${x.pct >= 100 ? 'full' : ''}">${x.pct >= 100 ? '✓ ' : ''}${Math.floor(x.pct)}%</span></span>
        <span class="pbar"><i style="width:${Math.min(100, x.pct)}%"></i></span>
        <span class="line small muted"><span>${fmtDist(x.km)} / ${fmtDist(c.distance_km)} km</span><span>${got}</span></span>
      </span>
      ${btn}
    </li>`;
  }).join('');
  return `<section class="card ch ${done ? 'done' : ''}">
    <div class="ch-head">
      <div><div class="ch-title">${fmtDist(c.distance_km)} km in ${durLabel(c)}</div>
        <div class="small muted">by ${c.creator === me ? 'you' : '@' + esc(unameOf(c.creator))} · ${left}</div></div>
      ${(c.creator === me) || (mine === 'joined' && !done) ? `<button class="x" data-chmenu="${c.id}" aria-label="Challenge options">⋯</button>` : ''}
    </div>
    ${rows.length ? `<ol class="rank">${rowHtml}</ol>` : '<div class="empty">Nobody has joined yet.</div>'}
    ${waiting.length && !done ? `<div class="small muted waiting">Waiting for ${waiting.map(m => '@' + esc(unameOf(m.user_id))).join(', ')}</div>` : ''}
  </section>`;
}
function renderChallenge() {
  const t = Date.now();
  const invites = challenges.list.filter(c => myStatus(c) === 'invited' && c.end > t);
  const active = challenges.list.filter(c => myStatus(c) === 'joined' && c.end > t);
  const past = challenges.list.filter(c => myStatus(c) === 'joined' && c.end <= t).sort((a, b) => b.end - a.end);
  $('#app').innerHTML = `${header()}
    <button class="btn primary" id="newCh" style="width:100%;margin-bottom:14px">+ New challenge</button>
    ${challenges.error ? `<div class="err" style="margin-bottom:10px">Couldn't load challenges. ${esc(typeof challenges.error === 'string' ? challenges.error : '')} <button class="linkbtn" id="chRetry">Try again</button></div>` : ''}
    ${invites.length ? `<section class="card"><h2>You've been challenged</h2>${invites.map(c => `
      <div class="req"><div class="who">@${esc(unameOf(c.creator))}: <span style="font-weight:500">${fmtDist(c.distance_km)} km in ${durLabel(c)}</span>
        <div class="small muted" style="font-weight:400">${fmtHours((c.end - t) / H)} left · ${c.members.filter(m => m.status === 'joined').length} joined</div></div>
        <button class="btn small" data-chdec="${c.id}">Decline</button><button class="btn small primary" data-chjoin="${c.id}">Join</button></div>`).join('')}</section>` : ''}
    ${!challenges.loaded && !challenges.error ? '<div class="empty center">Loading…</div>' :
      active.length ? active.map(challengeCard).join('') :
      `<section class="card center"><h2 style="justify-content:center">No running challenges</h2><p class="small muted" style="margin:0">Pick a distance and a time limit, invite friends, and see who gets there first.</p></section>`}
    ${past.length ? `<details class="card past"><summary><b>Past challenges</b> <span class="small muted">(${past.length})</span></summary>${past.map(challengeCard).join('')}</details>` : ''}`;
  bindHeader();
  $('#newCh').onclick = openNewChallenge;
  if ($('#chRetry')) $('#chRetry').onclick = loadChallenges;
  document.querySelectorAll('[data-chjoin]').forEach(b => b.onclick = () => answerInvite(b.dataset.chjoin, 'joined'));
  document.querySelectorAll('[data-chdec]').forEach(b => b.onclick = () => answerInvite(b.dataset.chdec, 'declined'));
  document.querySelectorAll('[data-cheer]').forEach(b => b.onclick = () => cheer(b));
  document.querySelectorAll('[data-chmenu]').forEach(b => b.onclick = () => {
    const c = challenges.list.find(x => x.id === b.dataset.chmenu); if (!c) return;
    if (c.creator === profile.id) confirmSheet('Delete this challenge?', `${fmtDist(c.distance_km)} km in ${durLabel(c)} disappears for everyone in it.`, 'Delete', async () => {
      const { error } = await sb.from('challenges').delete().eq('id', c.id);
      if (error) return toast("Couldn't delete it. Try again.");
      toast('Challenge deleted.'); loadChallenges();
    });
    else confirmSheet('Leave this challenge?', "You'll drop out of the ranking and can't rejoin.", 'Leave', () => answerInvite(c.id, 'declined'));
  });
}
async function answerInvite(cid, status) {
  const { error } = await sb.from('challenge_members').update({ status }).eq('challenge_id', cid).eq('user_id', profile.id);
  if (error) return toast("Couldn't do that. Try again.");
  toast(status === 'joined' ? "You're in! Every km you log now counts." : 'Challenge declined.');
  loadChallenges();
}
async function cheer(btn) {
  const [cid, to, kind] = btn.dataset.cheer.split('|');
  btn.disabled = true;
  const undo = btn.dataset.undo;
  const { error } = undo
    ? await sb.from('challenge_cheers').delete().eq('id', undo)
    : await sb.from('challenge_cheers').insert({ challenge_id: cid, from_user: profile.id, to_user: to, kind });
  if (error && error.code !== '23505') { btn.disabled = false; return toast("Couldn't send that. Try again."); }
  if (!undo) toast(kind === 'kudos' ? `👏 Kudos sent to <b>@${esc(unameOf(to))}</b>!` : `💪 You cheered on <b>@${esc(unameOf(to))}</b>.`);
  loadChallenges();
}
function openNewChallenge() {
  const accepted = friends.rows.filter(r => r.status === 'accepted').map(r => r.requester === profile.id ? r.addressee : r.requester)
    .sort((a, b) => unameOf(a).localeCompare(unameOf(b)));
  if (!accepted.length) {
    return openSheet(`<h3>New challenge</h3><p class="muted">You need at least one friend to challenge. Add friends by their username first.</p>
      <div class="grid2" style="margin-top:12px"><button class="btn" id="nc0">Close</button><button class="btn primary" id="nc1">Add friends</button></div>`, el => {
      el.querySelector('#nc0').onclick = closeSheet;
      el.querySelector('#nc1').onclick = () => { closeSheet(); tab = 'friends'; render(); };
    });
  }
  const st = { km: 20, dur: '1w', sel: new Set() };
  const draw = el => {
    const d = DURATIONS.find(x => x.k === st.dur);
    el.innerHTML = `<h3>New challenge</h3>
      <div class="field" style="margin-top:0"><label for="ckm">Distance (km)</label>
        <input id="ckm" class="text mono" inputmode="decimal" value="${st.km || ''}" autocomplete="off">
        <div class="chips" style="margin-top:8px">${DIST_PRESETS.map(k => `<button class="chip ${st.km === k ? 'sel' : ''}" data-km="${k}">${k} km</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Time limit</span><div class="chips">${DURATIONS.map(x => `<button class="chip ${st.dur === x.k ? 'sel' : ''}" data-dur="${x.k}">${x.label}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Challenge <button class="linkbtn" id="selAll" style="margin-left:6px">${st.sel.size === accepted.length ? 'Select none' : 'Select all'}</button></span>
        <div class="chips">${accepted.map(id => `<button class="chip ${st.sel.has(id) ? 'sel' : ''}" data-fr="${id}">@${esc(unameOf(id))}</button>`).join('')}</div></div>
      <p class="small muted" style="margin:14px 0 0">${st.km > 0 ? `Run <b>${fmtDist(st.km)} km</b> within <b>${d.label}</b>, starting now. Only runs from now on count.` : 'Enter a distance.'}</p>
      <div class="err" id="cerr2"></div>
      <div class="grid2" style="margin-top:6px"><button class="btn" id="ncx">Cancel</button><button class="btn primary" id="ncgo">Send challenge</button></div>`;
    const kmIn = el.querySelector('#ckm');
    kmIn.addEventListener('change', () => { st.km = parseFloat(kmIn.value.replace(',', '.')) || 0; draw(el); });
    el.querySelectorAll('[data-km]').forEach(b => b.onclick = () => { st.km = +b.dataset.km; draw(el); });
    el.querySelectorAll('[data-dur]').forEach(b => b.onclick = () => { st.km = parseFloat(kmIn.value.replace(',', '.')) || 0; st.dur = b.dataset.dur; draw(el); });
    el.querySelectorAll('[data-fr]').forEach(b => b.onclick = () => { st.km = parseFloat(kmIn.value.replace(',', '.')) || 0; st.sel.has(b.dataset.fr) ? st.sel.delete(b.dataset.fr) : st.sel.add(b.dataset.fr); draw(el); });
    el.querySelector('#selAll').onclick = () => { st.km = parseFloat(kmIn.value.replace(',', '.')) || 0; st.sel = st.sel.size === accepted.length ? new Set() : new Set(accepted); draw(el); };
    el.querySelector('#ncx').onclick = closeSheet;
    el.querySelector('#ncgo').onclick = async () => {
      st.km = parseFloat(kmIn.value.replace(',', '.')) || 0;
      const err = el.querySelector('#cerr2');
      if (!(st.km > 0) || st.km > 1000) { err.textContent = 'Pick a distance between 0 and 1000 km.'; return; }
      if (!st.sel.size) { err.textContent = 'Choose at least one friend to challenge.'; return; }
      const go = el.querySelector('#ncgo'); go.disabled = true;
      const id = newId();
      const { error } = await sb.from('challenges').insert({ id, creator: profile.id, distance_km: Math.round(st.km * 10) / 10, ends_at: new Date(Date.now() + d.days * D).toISOString() });
      if (error) { console.error(error); go.disabled = false; err.textContent = "Couldn't create the challenge. " + dbErrorText(error); return; }
      const rows = [{ challenge_id: id, user_id: profile.id, status: 'joined' }, ...[...st.sel].map(u => ({ challenge_id: id, user_id: u, status: 'invited' }))];
      const { error: e2 } = await sb.from('challenge_members').insert(rows);
      if (e2) { console.error(e2); await sb.from('challenges').delete().eq('id', id); go.disabled = false; err.textContent = "Couldn't invite your friends. " + dbErrorText(e2); return; }
      closeSheet();
      toast(`Challenge sent to ${[...st.sel].map(u => '<b>@' + esc(unameOf(u)) + '</b>').join(', ')}!`);
      loadChallenges();
    };
  };
  openSheet('', draw);
}


/* ============ connected watches ============ */
const WATCH_NAMES = { garmin: 'Garmin', coros: 'COROS', suunto: 'Suunto' };
async function loadWatches() {
  if (mode !== 'cloud') return;
  let links;
  try { links = await sb.from('watch_links').select('provider,connected_at,last_sync_at'); }
  catch (e) { links = { error: e, data: [] }; }
  let enabled = {}, fnOk = false;
  if (sb.functions) {
    try {
      const { data, error } = await sb.functions.invoke('watches', { body: { action: 'providers' } });
      if (!error && data) { enabled = data; fnOk = true; }
    } catch (e) { /* function not deployed yet */ }
  }
  watches = { loaded: true, enabled, setup: !links.error && fnOk,
    links: links.error ? {} : Object.fromEntries(links.data.map(l => [l.provider, l])) };
  autoSyncCoros();
  if (screen === 'app' && tab === 'pet' && !draft && !sheetOpen() && !isTyping()) {
    const d = document.querySelector('details.settings'); const open = d && d.open;
    render(); if (open) document.querySelector('details.settings').open = true;
  }
}
function watchesCard() {
  const row = id => {
    const link = watches.links[id], on = watches.enabled[id];
    let status, btn;
    if (link && !on) {
      status = 'Paused for now';
      btn = `<button class="btn small" data-woff="${id}">Disconnect</button>`;
    } else if (link) {
      status = `<span class="ok-dot"></span>Connected${link.last_sync_at ? ` · synced ${fmtAgo(Date.parse(link.last_sync_at), Date.now())}` : ' · waiting for your next run'}`;
      btn = `${id !== 'garmin' ? `<button class="btn small" data-wsync="${id}">Sync</button>` : ''}<button class="btn small" data-woff="${id}">Disconnect</button>`;
    } else if (on) {
      status = 'Not connected';
      btn = `<button class="btn small primary" data-won="${id}">Connect</button>`;
    } else {
      status = 'Coming soon';
      btn = '';
    }
    const diag = link && on && id === 'coros' ? `<button class="linkbtn small diag" data-wdiag="${id}">Check connection</button>` : '';
    return `<div class="wrow"><div class="wlogo ${id}">${WATCH_NAMES[id]}</div><div class="wstat small ${link ? '' : 'muted'}"><span>${status}${diag}</span></div><div class="wbtns">${btn}</div></div>`;
  };
  return `<div class="watches">
    <div class="row" style="margin-top:14px"><span class="small"><b>Your watches</b></span></div>
    ${['garmin', 'coros', 'suunto'].map(row).join('')}
    <p class="small muted" style="margin:10px 0 0">${Object.values(watches.links).length
      ? `New runs from your watch feed your pet automatically after it syncs with the brand's app${watches.links.coros && watches.enabled.coros ? ' (COROS is checked every 30 minutes and when you open the app)' : ''}. Only runs from after connecting count.`
      : 'Connect your watch and your runs feed your pet automatically. Brands marked "coming soon" are waiting for approval.'}</p>
  </div>`;
}
function bindWatches() {
  document.querySelectorAll('[data-won]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Opening…';
    const { data, error } = await sb.functions.invoke('watches', { body: { action: 'connect', provider: b.dataset.won } });
    if (error || !data || !data.url) { b.disabled = false; b.textContent = 'Connect'; return toast(`Couldn't start the connection. ${esc((data && data.error) || 'Try again.')}`); }
    location.href = data.url;
  });
  document.querySelectorAll('[data-woff]').forEach(b => b.onclick = () => {
    const id = b.dataset.woff;
    confirmSheet(`Disconnect ${WATCH_NAMES[id]}?`, 'New runs from this watch will stop arriving. Runs already imported stay in your log.', 'Disconnect', async () => {
      const { error } = await sb.functions.invoke('watches', { body: { action: 'disconnect', provider: id } });
      if (error) return toast("Couldn't disconnect. Try again.");
      toast(`${WATCH_NAMES[id]} disconnected.`); loadWatches();
    });
  });
  document.querySelectorAll('[data-wdiag]').forEach(b => b.onclick = () => openDiagnostics(b.dataset.wdiag));
  document.querySelectorAll('[data-wsync]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Syncing…';
    const { data, error } = await sb.functions.invoke('watches', { body: { action: 'sync', provider: b.dataset.wsync } });
    if (error) { b.disabled = false; b.textContent = 'Sync'; return toast(`Couldn't sync. ${b.dataset.wsync === 'coros' ? 'Tap “Check connection” for details.' : 'Try again.'}`); }
    toast(data && data.imported ? `Imported ${data.imported} new run${data.imported === 1 ? '' : 's'}.` : 'No new runs.');
    await refreshRuns(); loadWatches();
  });
}
// COROS doesn't push new runs, so ask for them when the app opens (at most every 10 minutes).
let corosSyncing = false, corosAutoAt = 0;
async function autoSyncCoros() {
  const link = watches.links.coros;
  if (!link || !watches.enabled.coros || corosSyncing || Date.now() - corosAutoAt < 10 * 60000) return;
  if (link.last_sync_at && Date.now() - Date.parse(link.last_sync_at) < 10 * 60000) return;
  corosSyncing = true; corosAutoAt = Date.now();
  try {
    const { data, error } = await sb.functions.invoke('watches', { body: { action: 'sync', provider: 'coros' } });
    if (!error && data && data.imported) await refreshRuns();
    if (!error) {
      const l = await sb.from('watch_links').select('provider,connected_at,last_sync_at').eq('provider', 'coros').maybeSingle();
      if (l.data) watches.links.coros = l.data;
      if (screen === 'app' && tab === 'pet' && !draft && !sheetOpen() && !isTyping()) render();
    }
  } catch (e) { console.error(e); }
  corosSyncing = false;
}
function openDiagnostics(id) {
  openSheet(`<h3>Checking ${WATCH_NAMES[id]}…</h3><div class="spinner" style="margin:30px auto"></div>`);
  sb.functions.invoke('watches', { body: { action: 'diagnose', provider: id } }).then(({ data, error }) => {
    const text = JSON.stringify(error ? { error: String(error.message || error) } : data, null, 2);
    const found = data && Array.isArray(data.found) ? data.found.filter(a => a.isRun).length : null;
    openSheet(`<h3>${WATCH_NAMES[id]} connection</h3>
      <p class="small muted" style="margin-top:0">${found != null ? `Found ${found} run${found === 1 ? '' : 's'} in the last few days using “${esc(data.picked)}”.` : 'Something didn\'t work.'} If runs are missing, copy this and send it to whoever maintains the app.</p>
      <pre class="diag-out">${esc(text)}</pre>
      <div class="grid2" style="margin-top:10px"><button class="btn" id="dgc">Close</button><button class="btn primary" id="dgcopy">Copy</button></div>`, el => {
      el.querySelector('#dgc').onclick = closeSheet;
      el.querySelector('#dgcopy').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch (e) { toast('Copy failed. Select the text and copy it by hand.'); } };
    });
  });
}
function showWatchReturn() {
  const name = WATCH_NAMES[watchReturn.provider] || 'Your watch';
  const msg = watchReturn.status === 'ok' ? `<b>${name} connected!</b> Your next run will feed your pet.`
    : watchReturn.status === 'cancelled' ? `${name} wasn't connected.`
    : watchReturn.reason === 'already_linked' ? `That ${name} account is already connected to another Runagotchi account.`
    : `Couldn't connect ${name}. Please try again.`;
  if (watchReturn.status === 'ok' && watchReturn.provider === 'coros') corosAutoAt = 0;
  settingsOpen = true; // show the watch status right where it was connected
  setTimeout(() => toast(msg, 6000), 300);
}
// Runs can arrive from a watch at any time: fetch them again when the app comes back.
async function refreshRuns() {
  if (mode !== 'cloud' || !profile) return;
  const { data, error } = await sb.from('runs').select('id,started_at,km,dur_min,source').eq('user_id', profile.id).order('started_at', { ascending: false });
  if (error || !S) return;
  const fresh = data.map(rowToRun);
  const added = fresh.filter(r => !S.runs.some(x => x.id === r.id));
  if (!added.length && fresh.length === S.runs.length) return;
  S.runs = fresh;
  if (screen === 'app' && tab === 'pet' && !draft && !sheetOpen() && !isTyping()) render();
  const fedKm = S.pet ? added.filter(r => r.date >= S.pet.createdAt).reduce((a, r) => a + r.km, 0) : 0;
  if (fedKm && tab === 'pet') { feedFx(fedKm); toast(`${added.length} new run${added.length === 1 ? '' : 's'} from your watch!`); }
}


/* ============ running together ============ */
// Monday 00:00 of the current week, local time.
const weekStart = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const pairKey = (a, b) => [a, b].sort().join('|');
const areBuddies = (a, b) => buddyPairs.has(pairKey(a, b));
// Everyone on the same run (the runner plus everyone tagged) ran together.
function computeBuddyPairs() {
  const since = weekStart(), byRun = {};
  for (const r of buddies.week) {
    if (Date.parse(r.started_at) < since) continue;
    (byRun[r.run_id] ??= new Set([r.owner_id])).add(r.friend_id);
  }
  const pairs = new Set();
  for (const set of Object.values(byRun)) {
    const a = [...set];
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) pairs.add(pairKey(a[i], a[j]));
  }
  return pairs;
}
const buddiesOf = id => [...buddyPairs].map(k => k.split('|')).filter(([a, b]) => a === id || b === id).map(([a, b]) => a === id ? b : a);
async function loadBuddies() {
  if (mode !== 'cloud' || !profile) return;
  try {
    const cols = 'run_id,owner_id,friend_id,started_at,km';
    const [mine, week] = await Promise.all([
      sb.from('run_companions').select(cols).eq('owner_id', profile.id),
      sb.from('run_companions').select(cols).gte('started_at', new Date(weekStart()).toISOString())
    ]);
    if (mine.error || week.error) throw (mine.error || week.error);
    const before = [...buddyPairs].sort().join(',') + buddies.mine.length + buddies.week.length;
    buddies = { loaded: true, mine: mine.data, week: week.data };
    buddyPairs = computeBuddyPairs();
    if (before === [...buddyPairs].sort().join(',') + buddies.mine.length + buddies.week.length) return;
  } catch (e) { console.error(e); return; }
  if (screen === 'app' && !draft && !sheetOpen() && !isTyping()) render();
}
const tagsForRun = runId => buddies.mine.filter(r => r.run_id === runId).map(r => r.friend_id);
const acceptedFriendIds = () => mode === 'cloud' ? friends.rows.filter(r => r.status === 'accepted')
  .map(r => r.requester === profile.id ? r.addressee : r.requester).sort((a, b) => unameOf(a).localeCompare(unameOf(b))) : [];
const friendChips = sel => acceptedFriendIds().map(id => `<button type="button" class="chip ${sel.has(id) ? 'sel' : ''}" data-buddy="${id}">@${esc(unameOf(id))}</button>`).join('');
function bindChips(el, sel) {
  el.querySelectorAll('[data-buddy]').forEach(b => b.onclick = () => {
    const id = b.dataset.buddy; sel.has(id) ? sel.delete(id) : sel.add(id); b.classList.toggle('sel', sel.has(id));
  });
}
async function saveRunBuddies(runId, add, remove) {
  if (add.length) {
    const { error } = await sb.from('run_companions').insert(add.map(f => ({ run_id: runId, owner_id: profile.id, friend_id: f })));
    if (error) { console.error(error); toast("Couldn't save who you ran with. " + esc(dbErrorText(error))); return false; }
  }
  for (const f of remove) await sb.from('run_companions').delete().eq('run_id', runId).eq('friend_id', f);
  await loadBuddies();
  return true;
}
function openRunBuddies(runId) {
  const r = S.runs.find(x => x.id === runId); if (!r) return;
  const cur = new Set(tagsForRun(runId)), sel = new Set(cur);
  openSheet(`<h3>Who ran with you?</h3><p class="small muted" style="margin-top:0">${fmtKm(r.km)} km · ${fmtDate(r.date)}</p>
    <div class="chips">${friendChips(sel)}</div>
    <p class="small muted">Everyone who runs together this week gets a 🤝 and runs side by side in the Run tab.</p>
    <div class="grid2" style="margin-top:12px"><button class="btn" id="bx">Cancel</button><button class="btn primary" id="bs">Save</button></div>`, el => {
    bindChips(el, sel);
    el.querySelector('#bx').onclick = closeSheet;
    el.querySelector('#bs').onclick = async () => {
      closeSheet();
      if (await saveRunBuddies(runId, [...sel].filter(x => !cur.has(x)), [...cur].filter(x => !sel.has(x)))) toast('Saved.');
    };
  });
}
// Friends who tagged you in a run this week that you haven't logged yourself.
const DISMISS_KEY = 'runagotchi.dismissedTags';
function incomingTags() {
  if (mode !== 'cloud' || !S) return [];
  let dismissed = []; try { dismissed = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); } catch (e) {}
  return buddies.week.filter(r => r.friend_id === profile.id && !dismissed.includes(r.run_id)
    && !S.runs.some(x => Math.abs(x.date - Date.parse(r.started_at)) < 3 * H));
}
function incomingCard() {
  const tags = incomingTags();
  if (!tags.length) return '';
  return `<section class="card"><h2>🤝 Ran with you</h2>${tags.map(r => `
    <div class="req"><div class="who">@${esc(unameOf(r.owner_id))} <span style="font-weight:400">ran ${fmtDist(Number(r.km))} km with you</span>
      <div class="small muted" style="font-weight:400">${fmtDate(Date.parse(r.started_at))}</div></div>
      <button class="x" data-tagdis="${r.run_id}" aria-label="Dismiss">×</button><button class="btn small primary" data-taglog="${r.run_id}">Log it too</button></div>`).join('')}
  </section>`;
}
function bindIncoming() {
  document.querySelectorAll('[data-tagdis]').forEach(b => b.onclick = () => {
    let d = []; try { d = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); } catch (e) {}
    d.push(b.dataset.tagdis); try { localStorage.setItem(DISMISS_KEY, JSON.stringify(d.slice(-200))); } catch (e) {}
    render();
  });
  document.querySelectorAll('[data-taglog]').forEach(b => b.onclick = async () => {
    const t = buddies.week.find(r => r.run_id === b.dataset.taglog); if (!t) return;
    const run = { id: newId(), date: Date.parse(t.started_at), km: Number(t.km), durMin: null, source: 'manual' };
    S.runs.push(run); render();
    if (run.date >= S.pet.createdAt) feedFx(run.km);
    await persistAddRuns([run]);
    if (acceptedFriendIds().includes(t.owner_id)) await saveRunBuddies(run.id, [t.owner_id], []);
    toast(`Logged! You and <b>@${esc(unameOf(t.owner_id))}</b> ran together this week 🤝`);
  });
}

/* ============ running group name ============ */
const packName = () => (profile && profile.pack_name) || 'The pack';
function openRenamePack() {
  openSheet(`<h3>Name your running group</h3>
    <p class="small muted" style="margin-top:0">Shown above your pack in the Run tab. Only you see your group's name, because everyone's pack is made of their own friends.</p>
    <input id="pn" class="text" maxlength="30" autocomplete="off" placeholder="The pack" value="${esc((profile && profile.pack_name) || '')}">
    <div class="small muted" style="margin-top:6px">Up to 30 characters. Leave empty for "The pack".</div>
    <div class="err" id="pnerr"></div>
    <div class="grid2" style="margin-top:8px"><button class="btn" id="pnx">Cancel</button><button class="btn primary" id="pns">Save</button></div>`, el => {
    const inp = el.querySelector('#pn'); setTimeout(() => { inp.focus(); inp.select(); }, 50);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#pns').click(); });
    el.querySelector('#pnx').onclick = closeSheet;
    el.querySelector('#pns').onclick = async () => {
      const name = inp.value.trim().replace(/\s+/g, ' ') || null;
      if (name && name.length > 30) { el.querySelector('#pnerr').textContent = 'Use 30 characters or fewer.'; return; }
      const btn = el.querySelector('#pns'); btn.disabled = true;
      const { error } = await sb.from('profiles').update({ pack_name: name }).eq('id', profile.id);
      btn.disabled = false;
      if (error) {
        el.querySelector('#pnerr').textContent = /pack_name/.test(error.message || '') ? 'Almost: run supabase/006_pack_name.sql in Supabase first.' : "Couldn't save. Try again.";
        return;
      }
      profile = { ...profile, pack_name: name };
      closeSheet(); render();
      toast(name ? `Your running group is now <b>${esc(name)}</b>.` : 'Back to "The pack".');
    };
  });
}


/* ============ debug (test accounts only) ============ */
const isDebug = () => mode === 'cloud' && !!(profile && profile.is_debug);
const DEBUG_STATES = [
  { k: 'full', label: 'Full', food: 100, h: 0 }, { k: 'fine', label: 'Fine', food: 60, h: 0 },
  { k: 'hungry', label: 'Hungry', food: 30, h: 0 }, { k: 'starving', label: 'Starving', food: 10, h: 0 },
  { k: 'fainted', label: 'Fainted', food: 0, h: 1 }, { k: 'starved', label: 'Starved', food: 0, h: 73 },
];
function debugTargets() {
  const list = [];
  if (S && S.pet) list.push({ id: profile.id, label: `You · ${S.pet.name}`, sim: simulate(S, now()), override: S.pet.debugAt != null });
  for (const id of acceptedFriendIds()) {
    const pr = friends.profiles[id], pet = friends.pets[id];
    if (pr && pr.is_debug && pet) list.push({ id, label: `@${pr.username} · ${pet.name}`, sim: simulateSnapshot(pet, Date.now()), override: pet.debug_at != null });
  }
  return list;
}
function debugCard() {
  if (!isDebug()) return '';
  const rows = debugTargets().map(x => `
    <div class="dbg-row">
      <div class="dbg-who"><b>${esc(x.label)}</b><span class="small muted">${moodOf(x.sim)} · ${Math.round(x.sim.f)} food${x.override ? ' · override on' : ''}</span></div>
      <div class="chips">${DEBUG_STATES.map(st => `<button class="chip small" data-dbg="${x.id}|${st.k}">${st.label}</button>`).join('')}
        ${x.override ? `<button class="chip small" data-dbg="${x.id}|reset">Reset</button>` : ''}</div>
    </div>`).join('');
  return `<section class="card dbg"><h2>🐞 Debug <span class="small muted">test account</span></h2>
    ${rows}
    <p class="small muted" style="margin:8px 0 0">Sets the pet's food right now (Fainted = empty for 1 h, Starved = empty for 73 h). Hunger keeps running and new runs still feed it. Test friends' pets can be changed too. Reset goes back to the real history. The time machine is in Settings.</p>
  </section>`;
}
function bindDebug() {
  document.querySelectorAll('[data-dbg]').forEach(b => b.onclick = async () => {
    const [id, k] = b.dataset.dbg.split('|');
    const st = DEBUG_STATES.find(x => x.k === k);
    b.disabled = true;
    const { error } = await sb.rpc('debug_set_pet', { p_target: id, p_food: st ? st.food : null, p_hours_ago: st ? st.h : 0 });
    if (error) { b.disabled = false; return toast("Couldn't change it. " + esc(error.message || '')); }
    if (id === profile.id) {
      const { data } = await sb.from('pets').select('*').eq('user_id', profile.id).maybeSingle();
      if (data) S.pet = rowToPet(data);
    }
    toast(st ? `Set to <b>${st.label}</b>.` : 'Back to the real history.');
    render(); loadFriends();
  });
}


/* ============ chat bubbles ============ */
// Bubbles that would overlap get stacked upwards, left to right.
function stackBubbles() {
  const scene = document.querySelector('.scene'); if (!scene) return;
  // offset* ignores CSS transforms, so the pop-in animation doesn't skew the sizes.
  const box = el => { const w = el.offsetWidth, h = el.offsetHeight, l = el.offsetLeft - w / 2; return { left: l, right: l + w, top: el.offsetTop, bottom: el.offsetTop + h }; };
  const minTop = 44; // keep clear of the group name
  const placed = [];
  [...scene.querySelectorAll('.bubble')].map(el => ({ el, r: box(el) })).sort((a, b) => a.r.left - b.r.left).forEach(({ el, r }) => {
    let lift = 0, moved = true;
    while (moved) {
      moved = false;
      for (const p of placed) {
        if (r.left < p.right + 4 && r.right > p.left - 4 && r.top - lift < p.bottom + 6 && r.bottom - lift > p.top - 6) { lift = r.bottom - p.top + 8; moved = true; }
      }
    }
    lift = Math.min(lift, Math.max(0, r.top - minTop)); // never above the scene's top
    if (lift) el.style.bottom = (parseFloat(el.style.bottom) + lift) + 'px';
    placed.push({ left: r.left, right: r.right, top: r.top - lift, bottom: r.bottom - lift });
  });
}
async function loadMessages() {
  if (mode !== 'cloud' || !profile) return;
  try {
    const { data, error } = await sb.from('pack_messages').select('user_id,body,created_at');
    if (error) throw error;
    const next = Object.fromEntries(data.map(m => [m.user_id, m]));
    if (JSON.stringify(next) === JSON.stringify(messages)) return;
    messages = next;
  } catch (e) { console.error(e); return; }
  if (screen === 'app' && tab === 'run' && !draft && !sheetOpen() && !isTyping()) render();
}
async function sendMessage(raw) {
  const body = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!body) return;
  if (body.length > 80) return toast('Keep it to 80 characters.');
  const btn = $('#saySend'); if (btn) btn.disabled = true;
  const row = { user_id: profile.id, body, created_at: new Date().toISOString() };
  const { error } = await sb.from('pack_messages').upsert(row);
  if (btn) btn.disabled = false;
  if (error) { console.error(error); return toast(/pack_messages/.test(error.message || '') ? 'Almost: run supabase/008_pack_chat.sql in Supabase first.' : "Couldn't send. Try again."); }
  messages = { ...messages, [profile.id]: row };
  if (document.activeElement) document.activeElement.blur();
  render();
}
async function clearMessage() {
  const { error } = await sb.from('pack_messages').delete().eq('user_id', profile.id);
  if (error) return toast("Couldn't remove it. Try again.");
  const m = { ...messages }; delete m[profile.id]; messages = m; render();
}

/* ============ sick / injured ============ */
async function setCondition(c) {
  const p = S.pet, t = now();
  if ((p.condition || null) === c) return;
  // Close the current rest period (if any) and start a new one.
  if (p.condition && p.conditionSince) p.restPeriods = [...(p.restPeriods || []), [p.conditionSince, t]];
  p.condition = c; p.conditionSince = c ? t : null;
  render();
  const ok = await persistPet();
  if (ok === false) return;
  toast(c === 'sick' ? `Get well soon! ${esc(p.name)} rests with you, and hunger is paused.`
    : c === 'injured' ? `Heal up! ${esc(p.name)} rests with you, and hunger is paused.`
    : `Welcome back! ${esc(p.name)} is hungry again from now on.`);
}

/* ============ add run ============ */
function openAddRun() {
  openSheet(`<h3>Log a run</h3>
    <div class="grid2">
      <div class="field" style="margin-top:0"><label for="rk">Distance (km)</label><input id="rk" class="text mono" inputmode="decimal" placeholder="5.0" autocomplete="off"></div>
      <div class="field" style="margin-top:0"><label for="rd">Time (min) <span class="muted small">optional</span></label><input id="rd" class="text mono" inputmode="numeric" placeholder="28" autocomplete="off"></div>
    </div>
    <div class="field"><label for="rt">When</label><input id="rt" type="datetime-local" class="text" value="${localInputValue(now())}"></div>
    ${acceptedFriendIds().length ? `<div class="field"><span class="lbl">Ran with <span class="muted small">optional</span></span><div class="chips">${friendChips(new Set())}</div></div>` : ''}
    <div class="err" id="rerr"></div>
    <div class="grid2" style="margin-top:8px"><button class="btn" id="rc">Cancel</button><button class="btn primary" id="rs">Feed ${esc(S.pet.name)}</button></div>`,
    el => {
      const k = el.querySelector('#rk'); setTimeout(() => k.focus(), 50);
      const with_ = new Set(); bindChips(el, with_);
      el.querySelector('#rc').onclick = closeSheet;
      el.querySelector('#rs').onclick = async () => {
        const km = parseFloat(k.value.replace(',', '.'));
        const durRaw = el.querySelector('#rd').value.replace(',', '.').trim();
        const dur = durRaw ? parseFloat(durRaw) : null;
        let when = new Date(el.querySelector('#rt').value).getTime();
        if (when <= now() && now() - when < 60000) when = now(); // "now" (the picker only has minutes)
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
        if (with_.size && await saveRunBuddies(run.id, [...with_], [])) toast(`Saved. You ran with ${[...with_].map(id => '<b>@' + esc(unameOf(id)) + '</b>').join(', ')} 🤝`);
      };
      el.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#rs').click(); }));
    });
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
  if (tab === 'run' && mode === 'cloud') return renderRun();
  if (tab === 'challenge' && mode === 'cloud') return renderChallenge();
  return renderPet();
}

// Hunger keeps ticking: redraw every minute, refresh friends every 5 minutes.
setInterval(() => {
  if (screen !== 'app' || draft || !S || !S.pet || sheetOpen() || isTyping() || tab === 'run') return;
  const d = document.querySelector('details.settings'); const open = d && d.open;
  render();
  if (open) document.querySelector('details.settings').open = true;
}, 60000);
setInterval(() => { if (mode === 'cloud' && screen === 'app') { loadFriends(); loadChallenges(); } }, 5 * 60000);
setInterval(() => { if (mode === 'cloud' && screen === 'app' && tab === 'run' && document.visibilityState === 'visible') loadMessages(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && mode === 'cloud' && screen === 'app') { refreshRuns(); loadFriends(); loadChallenges(); loadWatches(); loadBuddies(); loadMessages(); } });

boot();


/* ============ invite links (admins only) ============ */
const isAdmin = () => mode === 'cloud' && !!(profile && profile.is_admin);
const inviteLink = code => `${location.origin}${location.pathname}?invite=${encodeURIComponent(code)}`;
async function loadInvites() {
  if (!isAdmin() || invites.loading) return;
  invites.loading = true;
  const { data, error } = await sb.from('invites').select('code,created_at,used_by,used_at').order('created_at', { ascending: false });
  if (error) { console.error(error); invites = { loaded: true, list: [], error: true }; return; }
  invites = { loaded: true, list: data || [] };
  const used = invites.list.map(i => i.used_by).filter(id => id && !friends.profiles[id]);
  if (used.length) {
    const { data: ps } = await sb.from('profiles').select('id,username').in('id', used);
    (ps || []).forEach(p => { friends.profiles[p.id] = { ...(friends.profiles[p.id] || {}), ...p }; });
  }
  if (screen === 'app' && tab === 'friends' && !sheetOpen() && !isTyping()) render();
}
function invitesCard() {
  if (!isAdmin()) return '';
  if (!invites.loaded) { loadInvites(); }
  const open = invites.list.filter(i => !i.used_at), used = invites.list.filter(i => i.used_at);
  const who = id => (friends.profiles[id] || {}).username;
  return `<section class="card">
    <h2>Invite links <span class="small muted">admin</span></h2>
    <p class="small muted" style="margin:0 0 10px">Runagotchi is invite-only. Each link creates one account.</p>
    <button class="btn primary" id="newInvite" style="width:100%">+ New invite link</button>
    ${open.length ? `<ul class="invl">${open.map(i => `<li><code>${esc(i.code)}</code><span class="small muted">${fmtAgo(Date.parse(i.created_at), Date.now())}</span>
      <button class="btn small" data-invshare="${esc(i.code)}">Share</button><button class="btn small ghost" data-invdel="${esc(i.code)}" aria-label="Delete link">✕</button></li>`).join('')}</ul>` : ''}
    ${used.length ? `<div class="small muted" style="margin-top:10px">Used: ${used.map(i => who(i.used_by) ? '@' + esc(who(i.used_by)) : 'new account (no username yet)').join(', ')}</div>` : ''}
  </section>`;
}
async function shareInvite(code) {
  const url = inviteLink(code), text = 'Join me on Runagotchi, the running pet app. This link creates your account:';
  if (navigator.share) { try { await navigator.share({ title: 'Runagotchi invite', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied. Send it to your friend.'); }
  catch (e) { toast(`Invite link: <b>${esc(url)}</b>`, 12000); }
}
function bindInvites() {
  if (!$('#newInvite')) return;
  $('#newInvite').onclick = async () => {
    const b = $('#newInvite'); b.disabled = true;
    const { data, error } = await sb.rpc('create_invite');
    b.disabled = false;
    if (error) return toast("Couldn't create a link. " + esc(error.message || ''));
    invites.list.unshift({ code: data, created_at: new Date().toISOString(), used_by: null, used_at: null });
    render(); shareInvite(data);
  };
  document.querySelectorAll('[data-invshare]').forEach(b => b.onclick = () => shareInvite(b.dataset.invshare));
  document.querySelectorAll('[data-invdel]').forEach(b => b.onclick = () => confirmSheet('Delete this invite link?', "Nobody can create an account with it afterwards.", 'Delete', async () => {
    const { error } = await sb.from('invites').delete().eq('code', b.dataset.invdel);
    if (error) return toast("Couldn't delete it. Try again.");
    invites.list = invites.list.filter(i => i.code !== b.dataset.invdel); render(); toast('Invite link deleted.');
  }));
}
