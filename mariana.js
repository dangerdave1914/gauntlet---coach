/**
 * Mariana Tek — read-only client for the Members pane.
 *
 * Env vars (App Platform → App-Level Environment Variables):
 *   MT_API_KEY     the Admin API key from Mariana Tek. Mark it Encrypt.
 *   MT_SUBDOMAIN   defaults to "gauntletfitness" (gauntletfitness.marianatek.com)
 *   MT_LOCATION    defaults to 48717, Gauntlet's location ID
 *
 * Mariana Tek's Admin API speaks JSON:API: records come back as
 * { data: [{ id, type, attributes, relationships }], included: [...] }, and
 * related records (the member on a reservation) live in `included`, linked by
 * type + id. Everything below reads defensively, because the field names
 * here are taken from the public guides, not from a live response. Run
 * /api/members/probe once the key is set to see the real shape.
 *
 * Nothing here writes to Mariana Tek. The key should be issued read-only.
 */

const KEY = process.env.MT_API_KEY;
const SUB = (process.env.MT_SUBDOMAIN || 'gauntletfitness').trim();
const LOCATION = String(process.env.MT_LOCATION || '48717').trim();
const BASE = `https://${SUB}.marianatek.com/api`;
const TZ = 'America/Chicago';
const MAX_PAGES = 10;      // a single day at one gym never needs more; stops a runaway loop

const enabled = () => !!KEY;

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/vnd.api+json' },
  });
  const text = await res.text();
  if (!res.ok) {
    // 401/403 almost always means the key or its service-user permissions.
    const hint = res.status === 401 ? ' (key rejected: check MT_API_KEY)'
      : res.status === 403 ? ' (key works but lacks permission for this endpoint)'
      : res.status === 429 ? ' (rate limited)' : '';
    throw new Error(`Mariana Tek ${res.status} on ${path}${hint}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Mariana Tek returned non-JSON on ${path}`); }
}

/** Follows links.next so a busy day doesn't get cut off at page one. */
async function getAll(path, params = {}) {
  let body = await get(path, params);
  const data = [...(body.data || [])];
  const included = [...(body.included || [])];
  for (let i = 1; i < MAX_PAGES && body.links && body.links.next; i++) {
    const next = new URL(body.links.next);
    body = await get(path, Object.fromEntries(next.searchParams));
    data.push(...(body.data || []));
    included.push(...(body.included || []));
  }
  return { data, included };
}

/** id lookup for included records, keyed "type:id". */
function indexIncluded(included) {
  const map = new Map();
  for (const r of included) map.set(`${r.type}:${r.id}`, r);
  return map;
}
const relId = (rec, name) => rec && rec.relationships && rec.relationships[name]
  && rec.relationships[name].data && rec.relationships[name].data.id;
const rel = (rec, name, idx) => {
  const d = rec && rec.relationships && rec.relationships[name] && rec.relationships[name].data;
  return d ? idx.get(`${d.type}:${d.id}`) || null : null;
};

const first = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
};

/** "2026-11-16T17:30:00-06:00" -> { date: "2026-11-16", time: "5:30 PM", mins } in gym time. */
function gymClock(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return { date: null, time: '', mins: 9999 };
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(d).split(':').map(Number);
  return { date, time, mins: h * 60 + m };
}

/**
 * First name + last initial only. Coaches need to greet people, not see their
 * contact details — and this app has no real login yet, so whatever leaves
 * the server should be the least that's useful.
 */
function displayName(user, res) {
  const a = (user && user.attributes) || {};
  const fn = first(a, 'first_name', 'firstName') || '';
  const ln = first(a, 'last_name', 'lastName') || '';
  if (fn || ln) return `${fn}${ln ? ' ' + ln[0].toUpperCase() + '.' : ''}`.trim();
  // Guest bookings carry a guest_name on the reservation instead of a user.
  const g = first((res && res.attributes) || {}, 'guest_name');
  if (g) { const [f, ...rest] = String(g).trim().split(/\s+/); return rest.length ? `${f} ${rest.pop()[0].toUpperCase()}.` : f; }
  return 'Member';
}

/** Collapses Mariana Tek's reservation states into what a coach acts on. */
function statusOf(res) {
  const a = res.attributes || {};
  const s = String(first(a, 'status', 'reservation_status') || '').toLowerCase();
  const type = String(first(a, 'reservation_type') || '').toLowerCase();
  if (/cancel/.test(s)) return 'cancelled';
  if (/no.?show/.test(s)) return 'noshow';
  if (/check/.test(s) || a.is_checked_in === true || a.check_in_datetime) return 'in';
  if (/waitlist|standby/.test(type) || /waitlist|standby/.test(s)) return 'waitlist';
  return 'booked';
}

/** True only when Mariana Tek actually says so — never guessed. */
function isFirstVisit(res, user) {
  const a = (res && res.attributes) || {};
  const u = (user && user.attributes) || {};
  if (a.is_first_visit === true || a.is_first_class === true || a.is_first_reservation === true) return true;
  const n = first(u, 'completed_class_count', 'class_count', 'total_classes');
  return typeof n === 'number' && n === 0;
}

async function sessionsFor(date) {
  const { data, included } = await getAll('/class_sessions', {
    location: LOCATION, min_date: date, max_date: date, page_size: 100,
  });
  const idx = indexIncluded(included);
  return data.map(s => {
    const a = s.attributes || {};
    const start = first(a, 'start_datetime', 'start');
    const clock = gymClock(start);
    const instructor = rel(s, 'employee_public_profiles', idx) || rel(s, 'instructors', idx);
    return {
      id: s.id,
      date: clock.date || first(a, 'start_date'),
      time: clock.time || first(a, 'start_time') || '',
      mins: clock.mins,
      name: first(a, 'class_name', 'name', 'class_type_name') || 'Class',
      capacity: first(a, 'capacity', 'standard_capacity'),
      instructor: instructor ? first(instructor.attributes, 'name', 'display_name') : first(a, 'instructor_name'),
      cancelled: a.is_cancelled === true,
    };
  })
  // Don't trust the date filter's edges (inclusive or not, which timezone):
  // keep only what actually starts on this gym-local date.
  .filter(s => s.date === date)
  .sort((x, y) => x.mins - y.mins);
}

async function rosterFor(sessionId) {
  const { data, included } = await getAll('/reservations', {
    class_session: sessionId, include: 'user', page_size: 100,
  });
  const idx = indexIncluded(included);
  return data
    // If the class_session filter were ignored we'd get the whole gym; this
    // keeps the roster honest either way.
    .filter(r => !relId(r, 'class_session') || String(relId(r, 'class_session')) === String(sessionId))
    .map(r => {
      const user = rel(r, 'user', idx);
      const uid = relId(r, 'user') || null;
      if (uid && user) userCountFromAttrs(uid, user);
      return { uid, name: displayName(user, r), status: statusOf(r), firstVisit: isFirstVisit(r, user) };
    })
    .filter(p => p.status !== 'cancelled')
    .sort((a, b) => (b.firstVisit - a.firstVisit) || a.name.localeCompare(b.name));
}

/* Short cache: rosters move right up to class time, but six coaches opening
 * the pane at 5:10 shouldn't be six rounds of API calls. */
const cache = new Map();
const TTL = 2 * 60 * 1000;

async function day(date, { fresh = false } = {}) {
  const hit = cache.get(date);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;

  const sessions = await sessionsFor(date);
  const rosters = await Promise.all(sessions.map(s =>
    rosterFor(s.id).catch(e => ({ error: e.message }))));
  const uids = [...new Set(rosters.flatMap(r => Array.isArray(r) ? r.map(p => p.uid).filter(Boolean) : []))];
  const counts = await countsFor(uids);
  for (const r of rosters) if (Array.isArray(r)) for (const p of r) {
    const n = p.uid != null ? counts.get(p.uid) : null;
    p.classes = n == null ? null : n;
    p.tier = n == null ? null : tierFor(n);
    p.nextMilestone = n == null ? null : nextMilestone(n);
    delete p.uid;                      // Mariana Tek's user IDs stay on the server
  }
  const value = {
    date,
    classes: sessions.map((s, i) => {
      const r = rosters[i];
      const people = Array.isArray(r) ? r : [];
      return {
        time: s.time, name: s.name, instructor: s.instructor, capacity: s.capacity,
        cancelled: s.cancelled,
        booked: people.filter(p => p.status !== 'waitlist').length,
        checkedIn: people.filter(p => p.status === 'in').length,
        firstTimers: people.filter(p => p.firstVisit).length,
        people,
        error: Array.isArray(r) ? null : r.error,
      };
    }),
    updatedAt: new Date().toISOString(),
  };
  cache.set(date, { at: Date.now(), value });
  return value;
}

/**
 * Shape check for the first run: field NAMES only, never values, so it's safe
 * to paste into a chat. Shows whether the filters took and what the records
 * actually call things.
 */
async function probe(date) {
  const shape = rec => rec ? {
    type: rec.type,
    attributes: Object.keys(rec.attributes || {}).sort(),
    relationships: Object.keys(rec.relationships || {}).sort(),
  } : null;
  const out = { subdomain: SUB, location: LOCATION, date };
  try {
    const s = await get('/class_sessions', { location: LOCATION, min_date: date, max_date: date, page_size: 5 });
    out.classSessions = { count: (s.data || []).length, meta: s.meta || null, sample: shape((s.data || [])[0]) };
    const id = (s.data || [])[0] && s.data[0].id;
    if (id) {
      const r = await get('/reservations', { class_session: id, include: 'user', page_size: 5 });
      const recs = r.data || [];
      out.reservations = {
        count: recs.length, meta: r.meta || null,
        filterHeld: recs.every(x => !relId(x, 'class_session') || String(relId(x, 'class_session')) === String(id)),
        sample: shape(recs[0]),
        includedTypes: [...new Set((r.included || []).map(x => x.type))],
        userSample: shape((r.included || []).find(x => x.type === 'users')),
      };
      const uid = recs.map(x => relId(x, 'user')).find(Boolean);
      if (uid) {
        const h = await get('/reservations', { user: uid, page_size: 5 });
        out.userHistory = {
          count: (h.data || []).length, meta: h.meta ? Object.keys(h.meta) : null,
          filterHeld: (h.data || []).every(x => !relId(x, 'user') || String(relId(x, 'user')) === String(uid)),
          statuses: [...new Set((h.data || []).map(x => (x.attributes || {}).status))],
        };
      }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/* -------------------------------------------------------- class counts */

/**
 * Lifetime classes = checked-in reservations. If Mariana Tek's user record
 * carries a count, that wins; otherwise each member's reservation history is
 * counted once and cached, since it only moves by one a day.
 */
const MILESTONES = (process.env.MILESTONES || '25,50,100,200,300,400,500')
  .split(',').map(Number).filter(n => n > 0).sort((a, b) => a - b);
const COUNT_TTL = 6 * 60 * 60 * 1000;
const counts = new Map();   // uid -> { n, at }

function userCountFromAttrs(uid, user) {
  const u = (user && user.attributes) || {};
  const n = first(u, 'completed_class_count', 'lifetime_class_count', 'total_class_count',
    'class_count', 'total_classes', 'checked_in_count');
  if (typeof n === 'number') counts.set(String(uid), { n, at: Date.now(), source: 'attribute' });
}

async function countOne(uid) {
  const hit = counts.get(String(uid));
  if (hit && Date.now() - hit.at < COUNT_TTL) return hit.n;
  const { data } = await getAll('/reservations', { user: uid, page_size: 100 });
  const n = data
    .filter(r => !relId(r, 'user') || String(relId(r, 'user')) === String(uid))
    .filter(r => statusOf(r) === 'in').length;
  counts.set(String(uid), { n, at: Date.now(), source: 'history' });
  return n;
}

/** A few at a time: a full week of members shouldn't hit the API all at once. */
async function countsFor(uids, concurrency = 4) {
  const out = new Map(), queue = [...uids];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const uid = queue.shift();
      try { out.set(uid, await countOne(uid)); } catch { out.set(uid, null); }
    }
  }));
  return out;
}

/** The roadmap's screen tiers: WHITE through class 15, BLACK from 50. */
const tierFor = n => n < 15 ? 'WHITE' : n < 50 ? 'BLUE' : 'BLACK';
const nextMilestone = n => MILESTONES.find(m => m > n) || null;

/* ---------------------------------------------------------- milestones */

/**
 * Members booked in the next `days` days who are closing in on a milestone.
 * Their upcoming bookings are walked in order: if count + k lands on a
 * milestone, the k-th booking is the class where it happens, which is the
 * one to prep for. Anyone within `lead` classes who isn't booked far enough
 * ahead still shows up, just without a date.
 */
const LEAD = Number(process.env.MILESTONE_LEAD || 5);
const WINDOW = Number(process.env.MILESTONE_WINDOW_DAYS || 14);
let mileCache = null;
const MILE_TTL = 30 * 60 * 1000;

function addDaysIso(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function milestones({ fresh = false, today } = {}) {
  if (!fresh && mileCache && Date.now() - mileCache.at < MILE_TTL) return mileCache.value;
  today = today || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  // Every upcoming booking in the window, per member.
  const upcoming = new Map();   // uid -> { name, bookings: [{date,time,mins,name}] }
  for (let i = 0; i < WINDOW; i++) {
    const date = addDaysIso(today, i);
    const sessions = await sessionsFor(date);
    for (const s of sessions) {
      if (s.cancelled) continue;
      let roster;
      try { roster = await rosterFor(s.id); } catch { continue; }
      for (const p of roster) {
        if (!p.uid || p.status !== 'booked') continue;   // checked in = already counted
        const e = upcoming.get(p.uid) || { name: p.name, bookings: [] };
        e.bookings.push({ date, time: s.time, mins: s.mins, klass: s.name });
        upcoming.set(p.uid, e);
      }
    }
  }

  const n = await countsFor([...upcoming.keys()]);
  const pool = [];
  for (const [uid, e] of upcoming) {
    const have = n.get(uid);
    if (have == null) continue;
    const target = nextMilestone(have);
    if (!target) continue;
    e.bookings.sort((a, b) => a.date.localeCompare(b.date) || a.mins - b.mins);
    const k = target - have;                       // classes still to go
    const hit = e.bookings[k - 1] || null;         // the booking that lands on it
    if (!hit && k > LEAD) continue;
    pool.push({
      name: e.name, classes: have, milestone: target, toGo: k,
      on: hit ? { date: hit.date, time: hit.time, klass: hit.klass } : null,
      booked: e.bookings.length,
    });
  }
  pool.sort((a, b) =>
    (a.on ? 0 : 1) - (b.on ? 0 : 1) ||
    (a.on && b.on ? (a.on.date.localeCompare(b.on.date) || 0) : a.toGo - b.toGo) ||
    b.milestone - a.milestone);

  const value = { from: today, days: WINDOW, lead: LEAD, milestones: MILESTONES, pool, updatedAt: new Date().toISOString() };
  mileCache = { at: Date.now(), value };
  return value;
}

module.exports = { enabled, day, probe, milestones };
