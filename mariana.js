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
    signal: AbortSignal.timeout(20000),
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

/** The only write this app makes. JSON:API bodies, same auth as reads. */
async function post(path, body = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/vnd.api+json',
               'Content-Type': 'application/vnd.api+json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300) };
}

/** Follows links.next so a busy day doesn't get cut off at page one. */
async function getAll(path, params = {}) {
  let body = await get(path, params);
  const data = [...(body.data || [])];
  const included = [...(body.included || [])];
  // Mariana Tek reports pages in meta.pagination (the probe showed no
  // links block), so walk page numbers; follow a next link if one appears.
  for (let i = 1; i < MAX_PAGES; i++) {
    const pg = body.meta && body.meta.pagination;
    const nextLink = (body.links && body.links.next) || body.next;
    let nextParams;
    if (nextLink) nextParams = Object.fromEntries(new URL(nextLink).searchParams);
    else if (pg && pg.page && pg.pages && pg.page < pg.pages) nextParams = { ...params, page: pg.page + 1 };
    else break;
    body = await get(path, nextParams);
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

/** class_type_display may be a string or an object with a name. */
const displayText = v => v == null ? '' : typeof v === 'object' ? String(v.name || v.display || '') : String(v);
const namesOf = v => (Array.isArray(v) ? v : v ? String(v).split(/\s*,\s*/) : [])
  .map(x => typeof x === 'object' ? (x.name || x.full_name || '') : String(x)).map(x => x.trim()).filter(Boolean);

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
  if (/check/.test(s) || a.is_checked_in === true || a.check_in_datetime || a.check_in_date) return 'in';
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

// Set to e.g. "employee_public_profiles" once the probe shows that include
// works; until then instructor names come from attributes when present.
const SESSION_INCLUDE = (process.env.MT_SESSION_INCLUDE || '').trim();

async function sessionsFor(date) {
  return (await sessionsRange(date, date)).filter(s => s.date === date);
}

async function sessionsRange(min, max) {
  const { data, included } = await getAll('/class_sessions', {
    location: LOCATION, min_date: min, max_date: max, page_size: 100,
    include: SESSION_INCLUDE || undefined,
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
      name: displayText(first(a, 'class_type_display', 'class_name', 'name')) || 'Class',
      capacity: first(a, 'capacity', 'standard_capacity'),
      spots: first(a, 'available_spots', 'available_spot_count', 'remaining_capacity'),
      // instructor_names is a list (a class can have two coaches).
      instructors: namesOf(first(a, 'instructor_names', 'instructor_name'))
        .concat(instructor ? [first(instructor.attributes, 'schedule_display_name', 'name')].filter(Boolean) : []),
      get instructor() { return this.instructors.length ? [...new Set(this.instructors)].join(', ') : null; },
      cancelled: a.is_cancelled === true,
    };
  })
  // Don't trust the date filter's edges (inclusive or not, which timezone):
  // keep only what actually starts inside the range, in gym-local dates.
  .filter(s => s.date && s.date >= min && s.date <= max)
  .sort((x, y) => x.date.localeCompare(y.date) || x.mins - y.mins);
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
      return { rid: String(r.id), uid, name: displayName(user, r), status: statusOf(r), firstVisit: isFirstVisit(r, user) };
    })
    .filter(p => p.status !== 'cancelled')
    .sort((a, b) => (b.firstVisit - a.firstVisit) || a.name.localeCompare(b.name));
}

/* Short cache: rosters move right up to class time, but six coaches opening
 * the pane at 5:10 shouldn't be six rounds of API calls. */
const cache = new Map();
const TTL = 2 * 60 * 1000;
// Reservations the app has actually shown a coach. Check-in only accepts
// these, so the endpoint can't be pointed at an arbitrary reservation ID.
const known = new Map();   // rid -> { uid, date, status }

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
    if (p.rid) known.set(p.rid, { uid: p.uid, date, status: p.status });
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
    // Class names over the next two weeks, so MT_PRIVATE_MATCH can be set
    // to whatever Mariana Tek actually calls a private.
    const span = await get('/class_sessions', { location: LOCATION, min_date: date, max_date: addDaysIso(date, 14), page_size: 100 });
    const names = [...new Set((span.data || []).map(x => displayText(first(x.attributes || {}, 'class_type_display', 'class_name', 'name'))).filter(Boolean))];
    // Private names can carry the client's name, so those are counted, not listed.
    out.classNames = names.filter(n => !PRIVATE_MATCH.test(n)).sort();
    out.privateMatch = { pattern: PRIVATE_MATCH.source, matchingClassNames: names.filter(n => PRIVATE_MATCH.test(n)).length };
    // Does the instructor include work? (400 = no; that's fine.)
    try {
      const inc = await get('/class_sessions', { location: LOCATION, min_date: date, max_date: date, page_size: 1, include: 'employee_public_profiles' });
      out.instructorInclude = { ok: true, includedTypes: [...new Set((inc.included || []).map(x => x.type))],
        sample: shape((inc.included || [])[0]) };
    } catch (e) { out.instructorInclude = { ok: false, error: e.message }; }
    // Lesson-pack balances: where they live and what they're called.
    const someUid = id && out.reservations && (await get('/reservations', { class_session: id, include: 'user', page_size: 1 }))
      .data.map(x => relId(x, 'user')).find(Boolean);
    if (someUid) {
      try {
        const cr = await get(CREDITS_PATH, { user: someUid, page_size: 25 });
        const recs = cr.data || [];
        out.credits = { path: CREDITS_PATH, count: recs.length, sample: shape(recs[0]),
          filterHeld: recs.every(x => !relId(x, 'user') || String(relId(x, 'user')) === String(someUid)),
          originationTypes: [...new Set(recs.map(x => (x.attributes || {}).origination_type).filter(Boolean))],
          withBalance: recs.filter(x => typeof (x.attributes || {}).remaining_credits_cache === 'number').length,
          // Product names (not personal), so the private pack's name can be matched.
          creditNames: [...new Set(recs.map(x => (x.attributes || {}).credit_name).filter(Boolean))] };
      } catch (e) { out.credits = { path: CREDITS_PATH, error: e.message }; }
    }
    // Privates may be Mariana Tek Appointments, which live on their own
    // schedule, apart from class_sessions. Read-only GETs on likely paths;
    // a 404 just means "not here".
    out.appointments = {};
    // /appointments answers, but not with a list: likely a directory of
    // appointment endpoints. Report its keys (and any paths it names), then
    // read each one it points to. Keys and URLs only, no values.
    try {
      const root = await get('/appointments', {});
      const d = root.data;
      const desc = v => Array.isArray(v) ? `list(${v.length})` : v && typeof v === 'object' ? 'object' : typeof v;
      const links = {};
      const walk = (obj, prefix = '') => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && /^(https?:\/\/|\/)/.test(v)) links[prefix + k] = v.replace(/^https?:\/\/[^/]+/, '');
          else if (v && typeof v === 'object' && !Array.isArray(v) && prefix.split('.').length < 3) walk(v, prefix + k + '.');
        }
      };
      walk(root);
      out.appointmentsRoot = {
        topKeys: Object.keys(root),
        dataIs: desc(d),
        dataKeys: d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d) : null,
        dataShape: d && typeof d === 'object' && !Array.isArray(d) && d.type ? shape(d) : null,
        links,
      };
      // Follow what it names (max 12), relative to /api.
      out.appointmentsFollow = {};
      for (const [k, url] of Object.entries(links).slice(0, 12)) {
        const path = url.replace(/^\/api/, '').split('?')[0];
        try {
          const r = await get(path, { page_size: 3 });
          const list = Array.isArray(r.data) ? r.data : null;
          out.appointmentsFollow[k] = { path, ok: true, dataIs: desc(r.data), count: list ? list.length : null,
            meta: r.meta ? Object.keys(r.meta) : null, sample: list ? shape(list[0]) : null,
            names: list ? [...new Set(list.map(x => displayText(first(x.attributes || {}, 'name', 'display_name', 'service_name'))).filter(Boolean))] : null };
        } catch (e) { out.appointmentsFollow[k] = { path, ok: false, error: e.message.replace(/^Mariana Tek /, '') }; }
      }
    } catch (e) { out.appointmentsRoot = { error: e.message }; }

    // Appointments speak a different dialect: plain objects, not JSON:API,
    // and some lists need parameters (422 = validation). Read raw, keep
    // the validation message (it names the missing field), and try the
    // usual date/service parameter spellings.
    const raw = async (path, params) => {
      const url = new URL(BASE + path);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/vnd.api+json' } });   // plain JSON gets a 406
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text };
    };
    const keysOf = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null;
    const listOf = j => Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.results) ? j.results : null;
    // Error text, but only keys/messages: validation bodies name fields, not people.
    const errOf = r => r.json ? JSON.stringify(r.json).slice(0, 400) : r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
    const itemShape = x => !x ? null : x.attributes ? { keys: Object.keys(x), attributes: Object.keys(x.attributes) } : { keys: Object.keys(x) };

    const svc = await raw('/appointments/services', { page_size: 10 });
    const services = listOf(svc.json) || [];
    const svcAttr = x => x.attributes || x;
    out.appointmentServices = {
      status: svc.status, topKeys: keysOf(svc.json), count: services.length, item: itemShape(services[0]),
      names: services.map(x => String(svcAttr(x).service_name || svcAttr(x).name || '')).filter(Boolean),
      // How a provider (coach) is described: keys and the type value only.
      providerShape: (() => { const p = (svcAttr(services[0] || {}).providers || [])[0];
        return p && typeof p === 'object' ? { keys: Object.keys(p), type: p.type || p.provider_type || null } : (p == null ? null : typeof p); })(),
      providerCounts: services.map(x => (svcAttr(x).providers || []).length),
      ids: services.map(x => x.id).filter(Boolean),
    };
    // Round 3, using what Mariana Tek's errors told us:
    //  bookings: start_date/end_date as UTC "YYYY-MM-DDTHH:MM:SSZ", no page_size
    //  availabilities/timeblocks: provider_id + provider_type required
    //  categories: per_page <= 25
    const startZ = new Date(date + 'T00:00:00-06:00').toISOString().replace(/\.\d{3}Z$/, 'Z');
    const endZ = new Date(addDaysIso(date, 14) + 'T23:59:59-06:00').toISOString().replace(/\.\d{3}Z$/, 'Z');
    // Nested keys one level down, never values (bookings carry client info).
    const deepKeys = x => {
      if (!x || typeof x !== 'object') return null;
      const o = {};
      for (const [k, v] of Object.entries(x.attributes || x)) {
        o[k] = Array.isArray(v) ? (v[0] && typeof v[0] === 'object' ? ['list of', Object.keys(v[0])] : `list(${v.length})`)
          : v && typeof v === 'object' ? Object.keys(v) : (v === null ? 'null' : typeof v);
      }
      return o;
    };
    const tryOne = async (path, params) => {
      const r = await raw(path, params);
      const list = listOf(r.json);
      const t = { params: Object.keys(params).join(',') || '(none)', status: r.status };
      if (r.status < 300) { t.topKeys = keysOf(r.json); t.count = list ? list.length : null; t.meta = r.json && r.json.meta ? keysOf(r.json.meta) : null; t.item = deepKeys(list && list[0]); }
      else t.error = errOf(r);
      return t;
    };
    out.appointmentTries = {};
    // Round 4. Bookings want UTC timestamps; timeblocks want plain dates.
    // Look back 60 days for bookings so a past private shows its shape, and
    // check every coach on both services for slots.
    const back60Z = new Date(addDaysIso(date, -60) + 'T00:00:00-06:00').toISOString().replace(/\.\d{3}Z$/, 'Z');
    const firstHit = arr => arr.find(t => t.count) || arr[0];
    out.appointmentTries.bookings = [
      await tryOne('/appointments/bookings', { start_date: back60Z, end_date: endZ }),
    ];
    for (const sv of services.map(x => x.id)) {
      out.appointmentTries.bookings.push(Object.assign(
        await tryOne('/appointments/bookings', { start_date: back60Z, end_date: endZ, service_id: sv }), { service: sv }));
    }
    out.appointmentTries.categories = [ await tryOne('/appointments/categories', { per_page: 25 }) ];

    const providers = [];
    for (const x of services) for (const p of (svcAttr(x).providers || [])) {
      const id = p && typeof p === 'object' ? p.id : p;
      if (id != null && !providers.some(q => String(q.id) === String(id))) providers.push({ id, type: (p && p.type) || 'employee', service: x.id });
    }
    out.appointmentTries.providers = providers.length;
    const slots = { availabilities: [], timeblocks: [] };
    for (const p of providers) {
      const a = await tryOne('/appointments/availabilities', { provider_id: p.id, provider_type: p.type, start_date: startZ, end_date: endZ });
      const b = await tryOne('/appointments/timeblocks', { provider_id: p.id, provider_type: p.type, start_date: date, end_date: addDaysIso(date, 14) });
      slots.availabilities.push(Object.assign(a, { provider: `#${providers.indexOf(p) + 1}` }));
      slots.timeblocks.push(Object.assign(b, { provider: `#${providers.indexOf(p) + 1}` }));
    }
    // Per-coach counts, plus the shape of the first non-empty one.
    for (const k of ['availabilities', 'timeblocks']) {
      out.appointmentTries[k] = {
        perProvider: slots[k].map(t => t.status < 300 ? `${t.provider}: ${t.count}` : `${t.provider}: ${t.status} ${t.error || ''}`.slice(0, 140)),
        firstFound: (() => { const h = slots[k].find(t => t.count); return h ? { provider: h.provider, item: h.item, meta: h.meta } : null; })(),
      };
    }
    // Value FORMATS (digits masked) and enum values from bookings — none of
    // these identify anyone — so booking can be sent in the same shape.
    try {
      const bl = listOfAppt(await appt('/appointments/bookings', { start_date: back60Z, end_date: endZ, per_page: 25 }));
      const mask = v => v == null ? null : String(v).replace(/\d/g, '9');
      const uniq = f => [...new Set(bl.map(f).filter(x => x != null))].slice(0, 8);
      out.appointmentFormats = {
        count: bl.length,
        status: uniq(b => b.status), recurrence_type: uniq(b => b.recurrence_type), timezone: uniq(b => b.timezone),
        start_date: uniq(b => mask(b.start_date)), start_time: uniq(b => mask(b.start_time)), end_time: uniq(b => mask(b.end_time)),
        duration: uniq(b => b.duration), number_of_people: uniq(b => b.number_of_people), is_active: uniq(b => b.is_active),
        location_id_matches: uniq(b => String(b.location_id) === String(LOCATION)),
        participantsShape: (() => { const p = bl.find(b => b.metadata && b.metadata.participants); const x = p && p.metadata.participants;
          return Array.isArray(x) ? (x[0] && typeof x[0] === 'object' ? ['list of', Object.keys(x[0])] : `list(${x.length})`) : x ? typeof x : null; })(),
      };
    } catch (e) { out.appointmentFormats = { error: e.message }; }
    out.appointmentTries.bookingsFound = (() => { const h = firstHit(out.appointmentTries.bookings); return h && h.count ? h.item : null; })();
    // Common sub-paths, in case the directory doesn't name them.
    for (const sub of ['/appointments/appointments', '/appointments/bookings', '/appointments/slots', '/appointments/services', '/appointments/availability', '/appointments/sessions']) {
      try {
        const r = await get(sub, { page_size: 3 });
        const list = Array.isArray(r.data) ? r.data : null;
        out.appointments[sub] = { ok: true, dataIs: list ? `list(${list.length})` : typeof r.data, sample: list ? shape(list[0]) : null,
          topKeys: Object.keys(r) };
      } catch (e) { out.appointments[sub] = { ok: false, error: e.message.replace(/^Mariana Tek /, '') }; }
    }
    for (const path of (process.env.MT_APPT_PATHS || '/appointments,/appointment_bookings,/appointment_sessions,/appointment_reservations,/appointment_types,/services').split(',')) {
      try {
        const r = await get(path.trim(), { page_size: 3, min_date: date, max_date: addDaysIso(date, 14) });
        const list = Array.isArray(r.data) ? r.data : [];
        out.appointments[path.trim()] = { ok: true, dataIsList: Array.isArray(r.data), count: list.length, meta: r.meta || null, sample: shape(list[0]),
          // Type/service names aren't personal; list them so we know what privates are called.
          names: [...new Set(list.map(x => displayText(first(x.attributes || {}, 'name', 'service_name', 'appointment_type_display', 'display_name'))).filter(Boolean))] };
      } catch (e) { out.appointments[path.trim()] = { ok: false, error: e.message.replace(/^Mariana Tek /, '') }; }
    }
    out.checkIn = 'Not probed — it would change a real record. The first tap in the app will report whether it works.';
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

/* ------------------------------------------------------------ check-in */

/**
 * Marks one reservation checked in. Mariana Tek documents
 * POST /reservations/{id}/cancel; check-in is assumed to follow the same
 * pattern. A 404/405 means the path is wrong (safe to try the next), and is
 * reported rather than guessed past.
 */
const CHECKIN_PATHS = (process.env.MT_CHECKIN_PATHS || 'check_in,check-in').split(',').map(x => x.trim()).filter(Boolean);

async function checkIn(rid) {
  rid = String(rid || '');
  const r = known.get(rid);
  if (!r) throw new Error('That reservation isn\'t on a roster the app has loaded. Refresh and try again.');
  if (r.status === 'in') return { ok: true, already: true };
  let last;
  for (const suffix of CHECKIN_PATHS) {
    last = await post(`/reservations/${encodeURIComponent(rid)}/${suffix}`);
    if (last.ok) break;
    if (last.status !== 404 && last.status !== 405) break;
  }
  if (!last.ok) {
    if (last.status === 403) throw new Error('Mariana Tek refused: the API key doesn\'t have check-in permission. Ask integrations@marianatek.com to add it.');
    if (last.status === 404 || last.status === 405) throw new Error('Mariana Tek has no check-in endpoint where the app looked. Check in at the desk for now.');
    const msg = last.json && last.json.errors && last.json.errors[0] && (last.json.errors[0].detail || last.json.errors[0].title);
    throw new Error(`Mariana Tek ${last.status}${msg ? ': ' + msg : ''}`);
  }
  r.status = 'in';
  cache.delete(r.date);                          // roster shows it on next load
  if (r.uid) {                                   // one more class toward their milestone
    const c = counts.get(String(r.uid));
    if (c) c.n += 1;
  }
  mileCache = null;
  return { ok: true };
}

/* ------------------------------------------------------------ privates */

/**
 * Private lessons are Mariana Tek Appointments under a service whose name
 * matches PRIVATE_MATCH, paid from a lesson pack (credits). For each client: their
 * recent and upcoming privates, who teaches them, and what's left in the pack.
 * Two lessons left or fewer = time to talk renewal.
 */
const PRIVATE_MATCH = new RegExp(process.env.MT_PRIVATE_MATCH || 'private', 'i');
const PRIVATE_LOW = Number(process.env.PRIVATE_LOW || 2);
// /credits turned out to be credit TYPES (no balances). Balances live on
// credit_transactions: one per package purchase/gift, carrying
// remaining_credits_cache, credit_name, expiration_datetime and is_expired.
const CREDITS_PATH = process.env.MT_CREDITS_PATH || '/credit_transactions';
let privCache = null;
const PRIV_TTL = 10 * 60 * 1000;
// Where a client buys a lesson pack themselves (a Mariana Tek web link).
const PACK_URL = (process.env.MT_PACK_URL || '').trim();

// The browser only ever sees opaque client tokens and slot IDs the app has
// listed, so booking can't be aimed at arbitrary members or classes.
const crypto = require('crypto');
const tokens = new Map();     // token -> uid
const tokenOf = new Map();    // uid -> token
function tokenFor(uid) {
  uid = String(uid);
  if (!tokenOf.has(uid)) { const t = crypto.randomBytes(9).toString('base64url'); tokenOf.set(uid, t); tokens.set(t, uid); }
  return tokenOf.get(uid);
}

/** Lessons left in a client's private packs, or null if Mariana Tek won't say.
 *  Each package keeps its own balance, so live private packages are summed. */
async function packFor(uid) {
  const { data } = await getAll(CREDITS_PATH, { user: uid, page_size: 100 });
  const mine = data.filter(t => !relId(t, 'user') || String(relId(t, 'user')) === String(uid));
  const now = new Date().toISOString();
  // A balance-carrying record: has a remaining count, isn't expired. If
  // origination_type is present, only package-creating records count, so a
  // usage record that echoes the same cache isn't added twice.
  let live = mine.filter(t => {
    const a = t.attributes || {};
    if (typeof a.remaining_credits_cache !== 'number') return false;
    if (a.is_expired === true) return false;
    if (a.expiration_datetime && String(a.expiration_datetime) < now) return false;
    return PRIVATE_MATCH.test(String(a.credit_name || ''));
  });
  if (live.some(t => t.attributes.origination_type)) live = live.filter(t => t.attributes.origination_type);
  if (!live.length) return { left: null, packs: 0, expires: null, label: null };
  let left = 0, expires = null;
  for (const t of live) {
    const a = t.attributes;
    left += a.remaining_credits_cache;
    const e = a.expiration_datetime;
    if (e && a.remaining_credits_cache > 0 && (!expires || e < expires)) expires = e;
  }
  return { left, packs: live.length, expires: expires ? String(expires).slice(0, 10) : null,
           label: String(live[0].attributes.credit_name || '') };
}

/* ------------------------------------------------ appointments (privates) */

/**
 * Privates live in Mariana Tek Appointments, a separate API from classes:
 * plain objects in `data` (not JSON:API attributes), UTC timestamps for
 * booking date filters, no page_size, per_page capped at 25. The probe
 * found Gauntlet's two services, "Personal Training" and "PRIVATE LESSONS";
 * MT_PRIVATE_MATCH picks which count as privates (default "private").
 */
async function appt(path, params = {}, { method = 'GET', body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/vnd.api+json',
               ...(body ? { 'Content-Type': 'application/vnd.api+json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = json && (json.error || (json.errors && (json.errors.detail || (json.errors[0] && (json.errors[0].detail || json.errors[0].title)))));
    const e = new Error(`Mariana Tek ${res.status} on ${path}${msg ? ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)) : ''}`);
    e.status = res.status; e.body = json;
    throw e;
  }
  return json;
}
const listOfAppt = j => Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.results) ? j.results : [];

async function apptAll(path, params = {}) {
  const out = [];
  let page = 1;
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await appt(path, { ...params, ...(page > 1 ? { page } : {}) });
    out.push(...listOfAppt(j));
    const pg = j && j.meta && j.meta.pagination;
    if (!pg || !pg.pages || page >= pg.pages) break;
    page++;
  }
  return out;
}

const utcZ = (iso, hhmmss, offset = '-06:00') =>
  new Date(`${iso}T${hhmmss}${offset}`).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** "14:30:00" / "14:30" / "2:30 PM" / ISO -> { date, time label, mins } in gym time. */
function apptWhen(b) {
  const sd = String(b.start_date || ''), st = String(b.start_time || '');
  // Live format (probe): start_date "YYYY-MM-DDTHH:MM:SSZ" is the lesson's
  // start in UTC; start_time "HH:MM". The timestamp is authoritative.
  if (/T\d.*(Z|[+-]\d{2}:?\d{2})$/.test(sd)) return gymClock(sd);
  if (/T\d/.test(st)) return gymClock(st);
  const date = sd.slice(0, 10);
  const m = st.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  if (!m) return { date, time: st, mins: 9999 };
  let h = Number(m[1]); const mm = Number(m[2]);
  if (m[3]) { h = h % 12 + (/p/i.test(m[3]) ? 12 : 0); }
  const label = `${(h % 12) || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return { date, time: label, mins: h * 60 + mm };
}
const cancelledBooking = b => b.is_active === false || /cancel|void|delete|no.?show/i.test(String(b.status || ''));

let svcCache = null;
async function privateServices() {
  if (svcCache && Date.now() - svcCache.at < 60 * 60 * 1000) return svcCache.list;
  const all = listOfAppt(await appt('/appointments/services', { per_page: 25 }));
  const list = all.filter(x => PRIVATE_MATCH.test(String(x.service_name || x.name || '')) && x.is_active !== false);
  svcCache = { at: Date.now(), list };
  return list;
}

/**
 * Employee id -> display name. Appointment providers carry only an id, so
 * names come from the class schedule's employee_public_profiles (each links
 * to its employee), with /employees/{id} as a fallback.
 */
const coachNames = new Map();
let coachMapAt = 0;
async function loadCoachNames(today) {
  if (Date.now() - coachMapAt < 6 * 60 * 60 * 1000) return;
  try {
    const { included } = await getAll('/class_sessions', {
      location: LOCATION, min_date: addDaysIso(today, -30), max_date: addDaysIso(today, 14),
      page_size: 100, include: 'employee_public_profiles',
    });
    for (const p of included || []) {
      if (p.type !== 'employee_public_profiles') continue;
      const emp = relId(p, 'employee');
      const name = first(p.attributes || {}, 'schedule_display_name', 'name');
      if (emp && name) coachNames.set(String(emp), String(name));
    }
    coachMapAt = Date.now();
  } catch (e) { console.error('coach names:', e.message); }
}
async function coachName(id) {
  id = String(id);
  if (coachNames.has(id)) return coachNames.get(id);
  try {
    const j = await get(`/employees/${encodeURIComponent(id)}`);
    const a = (j.data && j.data.attributes) || {};
    const n = first(a, 'full_name', 'display_name', 'name') ||
      [first(a, 'first_name'), first(a, 'last_name')].filter(Boolean).join(' ');
    if (n) { coachNames.set(id, n); return n; }
  } catch {}
  coachNames.set(id, null);
  return null;
}

/** Client display names, from the member record. */
const clientNames = new Map();
async function clientName(uid) {
  uid = String(uid);
  if (clientNames.has(uid)) return clientNames.get(uid);
  let name = 'Client';
  try { const j = await get(`/users/${encodeURIComponent(uid)}`); name = displayName(j.data, null); } catch {}
  clientNames.set(uid, name);
  return name;
}

async function pool(items, fn, n = 4) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) { const x = q.shift(); await fn(x); } }));
}

let lastBookings = [];   // kept as a format template for creating bookings

async function privates({ fresh = false, today } = {}) {
  if (!fresh && privCache && Date.now() - privCache.at < PRIV_TTL) return privCache.value;
  today = today || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const from = addDaysIso(today, -30), to = addDaysIso(today, 30);
  const services = await privateServices();
  await loadCoachNames(today);

  const bookings = [];
  for (const sv of services) {
    const list = await apptAll('/appointments/bookings', {
      start_date: utcZ(from, '00:00:00'), end_date: utcZ(to, '23:59:59'), service_id: sv.id, per_page: 25,
    });
    for (const b of list) if (String(b.service_id) === String(sv.id) || b.service_id == null) bookings.push({ ...b, _svc: sv });
  }
  lastBookings = bookings.filter(b => !cancelledBooking(b));

  // Names, a few at a time.
  const uids = [...new Set(bookings.map(b => b.customer_id).filter(Boolean).map(String))];
  const pids = [...new Set(bookings.flatMap(b => (b.providers || []).map(p => p.id)).concat(
    services.flatMap(s => (s.providers || []).map(p => p && typeof p === 'object' ? p.id : p))).filter(x => x != null).map(String))];
  await pool(uids, clientName);
  await pool(pids, coachName);

  const now = new Date();
  const nowDate = today, nowMins = (() => { const c = gymClock(now.toISOString()); return c.mins; })();
  const clients = new Map();
  const upcomingAll = [];
  for (const b of bookings) {
    if (cancelledBooking(b) || !b.customer_id) continue;
    const w = apptWhen(b);
    const coaches = (b.providers || []).map(p => coachNames.get(String(p.id))).filter(Boolean);
    const future = w.date > nowDate || (w.date === nowDate && w.mins >= nowMins);
    const uid = String(b.customer_id);
    const c = clients.get(uid) || { uid, name: clientNames.get(uid) || 'Client', coaches: new Set(), lessons: [] };
    coaches.forEach(n => c.coaches.add(n));
    c.lessons.push({ date: w.date, time: w.time, mins: w.mins, coach: coaches.join(', ') || null, upcoming: future,
                     status: String(b.status || '') });
    clients.set(uid, c);
    if (future) upcomingAll.push({ date: w.date, time: w.time, mins: w.mins, client: c.name, coach: coaches.join(', ') || null,
                                   coaches, service: b._svc.service_name });
  }

  const list = [...clients.values()];
  let packError = null;
  await pool(list, async c => { try { c.pack = await packFor(c.uid); } catch (e) { c.pack = null; packError = packError || e.message; } });

  const out = list.map(c => {
    const done = c.lessons.filter(l => !l.upcoming);
    const next = c.lessons.filter(l => l.upcoming).sort((a, b) => a.date.localeCompare(b.date) || a.mins - b.mins)[0] || null;
    const left = c.pack ? c.pack.left : null;
    return {
      cid: tokenFor(c.uid), name: c.name, coaches: [...c.coaches],
      lastLesson: done.map(l => l.date).sort().pop() || null,
      nextLesson: next ? { date: next.date, time: next.time, coach: next.coach } : null,
      upcoming: c.lessons.filter(l => l.upcoming).length, doneLast30: done.length,
      left, expires: c.pack ? c.pack.expires : null, packLabel: c.pack ? c.pack.label : null,
      renew: left != null && left <= PRIVATE_LOW,
    };
  }).sort((a, b) => (b.renew - a.renew) || ((a.left ?? 99) - (b.left ?? 99)) || a.name.localeCompare(b.name));

  // Coaches who can take a private, for the booking form.
  const svcCoaches = [];
  for (const sv of services) for (const p of sv.providers || []) {
    const id = String(p && typeof p === 'object' ? p.id : p);
    if (!svcCoaches.some(x => x.pid === id)) svcCoaches.push({ pid: id, type: (p && p.type) || 'employee', name: coachNames.get(id) || null, service: sv.id });
  }

  upcomingAll.sort((a, b) => a.date.localeCompare(b.date) || a.mins - b.mins);
  const value = {
    from, to, low: PRIVATE_LOW, clients: out, upcoming: upcomingAll.slice(0, 60), packError,
    services: services.map(s => ({ id: s.id, name: s.service_name,
      minutes: Number(s.duration) > 300 ? Math.round(Number(s.duration) / 60) : Number(s.duration) || null,
      coachIds: (s.providers || []).map(p => String(p && typeof p === 'object' ? p.id : p)) })),
    coaches: svcCoaches, bookings: bookings.length,
    counts: { live: lastBookings.length, upcoming: upcomingAll.length,
              past: bookings.filter(b => !cancelledBooking(b)).length - upcomingAll.length },
    packUrl: PACK_URL || null, updatedAt: new Date().toISOString(),
  };
  privCache = { at: Date.now(), value };
  return value;
}

/* ---------------------------------------------------- booking a private */

/**
 * Creates an appointment booking. Field formats are copied from an existing
 * booking (date as YYYY-MM-DD or not, time with or without seconds,
 * timezone, location, recurrence type), because Mariana Tek's appointment
 * API isn't documented publicly and its own records are the best spec.
 * Mariana Tek's error text is passed through word for word.
 */
/** Gym-local date + HH:MM -> UTC "YYYY-MM-DDTHH:MM:SSZ", DST-correct for Chicago. */
function chicagoToUtcZ(date, h, m) {
  for (const off of ['-06:00', '-05:00']) {
    const d = new Date(`${date}T${pad(h)}:${pad(m)}:00${off}`);
    const c = gymClock(d.toISOString());
    if (c.date === date && c.mins === h * 60 + m) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  throw new Error('Couldn\'t work out that time in Central time.');
}

function hhmm(t) { const m = String(t).match(/^(\d{1,2}):(\d{2})$/); return m ? [Number(m[1]), Number(m[2])] : null; }
const pad = n => String(n).padStart(2, '0');

async function bookPrivate({ cid, date, time, pid, serviceId }) {
  const uid = tokens.get(String(cid || ''));
  if (!uid) throw new Error('Pick a client from the list.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Pick a date.');
  const hm = hhmm(time); if (!hm) throw new Error('Pick a start time.');
  const services = await privateServices();
  const sv = services.find(s => String(s.id) === String(serviceId)) || services[0];
  if (!sv) throw new Error('No private-lesson service found in Mariana Tek.');
  const prov = (sv.providers || []).find(p => String(p && typeof p === 'object' ? p.id : p) === String(pid));
  if (!prov) throw new Error('That coach isn\'t set up to teach this service in Mariana Tek.');

  const tpl = lastBookings.find(b => String(b.service_id) === String(sv.id)) || lastBookings[0] || {};
  // Mariana Tek gives duration in SECONDS (the probe's service said 3600).
  const durRaw = Number(sv.duration || tpl.duration || 3600);
  const dur = durRaw > 300 ? Math.round(durRaw / 60) : durRaw;     // minutes
  if (dur < 10 || dur > 240) throw new Error(`Service length looks wrong (${durRaw}). Not booking.`);
  const endMins = hm[0] * 60 + hm[1] + dur;
  if (endMins >= 1440) throw new Error('That lesson would run past midnight. Pick an earlier time.');
  // Live bookings: start_time/end_time "HH:MM", start_date a UTC timestamp.
  const withSecs = /:\d{2}:\d{2}$/.test(String(tpl.start_time || ''));
  const fmtT = (h, m) => `${pad(h)}:${pad(m)}${withSecs ? ':00' : ''}`;
  const tsDates = !tpl.start_date || /T\d/.test(String(tpl.start_date));
  const eh = Math.floor(endMins / 60), em = endMins % 60;
  const body = {
    service_id: sv.id,
    customer_id: String(uid),
    providers: [{ id: prov.id != null ? prov.id : prov, type: prov.type || 'employee' }],
    number_of_people: 1,
    start_date: tsDates ? chicagoToUtcZ(date, hm[0], hm[1]) : date,
    end_date: tsDates ? chicagoToUtcZ(date, eh, em) : date,
    start_time: fmtT(hm[0], hm[1]), end_time: fmtT(eh, em),
    duration: durRaw > 300 ? durRaw : dur * 60,      // back to seconds, as Mariana Tek stores it
    timezone: tpl.timezone || TZ,
    ...(tpl.location_id ? { location_id: tpl.location_id } : (sv.locations && sv.locations[0] ? { location_id: String(sv.locations[0].id || sv.locations[0]) } : { location_id: LOCATION })),
    // Never copy a repeating setting: the template may be a weekly series,
    // and a one-off booking must not become one. Only a clearly one-time
    // value is passed along; otherwise Mariana Tek's default applies.
    recurrence_type: 'NONE',          // every live booking is NONE; a one-off must never repeat
    status: 'SCHEDULED',
  };
  let r;
  const t0 = Date.now();
  console.log('book private: POST start', JSON.stringify({ ...body, customer_id: '…' }));
  try { r = await appt('/appointments/bookings', {}, { method: 'POST', body }); console.log(`book private: POST ok in ${Date.now() - t0}ms`); }
  catch (e) {
    console.log(`book private: POST failed in ${Date.now() - t0}ms: ${e.message}`);
    if (e.name === 'TimeoutError' || /aborted|timeout/i.test(e.message)) throw new Error('Mariana Tek didn\'t answer within 20 seconds. Check Mariana Tek before trying again: the booking may have gone through.');
    if (e.status === 403) throw new Error('Mariana Tek refused: the API key doesn\'t have permission to create appointment bookings. Ask integrations@marianatek.com to add it.');
    throw new Error(e.message.replace(/ on \/appointments\/bookings/, ''));
  }
  privCache = null;
  const made = (r && (r.data || r)) || {};
  return { ok: true, booking: made.id != null ? String(made.id) : null };
}

/** Coaches on the private services, named — without rebuilding the whole
 *  Privates list (that's dozens of calls; booking must stay fast). */
async function privateCoaches(today) {
  if (privCache && privCache.value && privCache.value.coaches) return privCache.value.coaches;
  const services = await privateServices();
  await loadCoachNames(today);
  const out = [];
  for (const sv of services) for (const p of sv.providers || []) {
    const id = String(p && typeof p === 'object' ? p.id : p);
    if (!out.some(x => x.pid === id)) out.push({ pid: id, type: (p && p.type) || 'employee', name: coachNames.get(id) || await coachName(id) });
  }
  return out;
}

/** Which Mariana Tek coach (employee id) is this staff member? By name. */
function coachIdFor(staffName, coaches, same) {
  const hit = (coaches || []).find(c => c.name && same(c.name, staffName));
  return hit ? hit.pid : null;
}

module.exports = { enabled, day, probe, milestones, checkIn, privates, bookPrivate, coachIdFor, privateCoaches };
