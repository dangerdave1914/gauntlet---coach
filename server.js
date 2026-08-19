/**
 * Gauntlet Coach — server
 * DigitalOcean App Platform (Node 20+)
 *
 * Sheet access goes through the Apps Script bridge (Code.gs), not a service
 * account — the script runs as David, so it already sees both files.
 *
 * Env vars to set in App Platform → Settings → App-Level Environment Variables:
 *   APPS_SCRIPT_URL      the /exec URL from the Apps Script deployment
 *   APPS_SCRIPT_SECRET   must match SHARED_SECRET in the script properties (mark Encrypt)
 *   CONFIRMERS           who can confirm a week's programming rollout
 *   ANNOUNCERS           who can post announcements (defaults to CONFIRMERS)
 *   SCHEDULERS           who can build the schedule and assign coaches
 *   PORT                 (App Platform sets this automatically)
 */

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;
const CURRICULUM = 'curriculum';
const PROGRAMMING = 'programming';
const emails = v => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CONFIRMERS = emails(process.env.CONFIRMERS);
const ANNOUNCERS = emails(process.env.ANNOUNCERS).length
  ? emails(process.env.ANNOUNCERS) : CONFIRMERS;
const SCHEDULERS = emails(process.env.SCHEDULERS).length
  ? emails(process.env.SCHEDULERS) : CONFIRMERS;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------------------------------------------------------------- bridge */

/**
 * Apps Script answers a POST with a 302, and the actual payload lives at the
 * redirect — which only accepts GET. fetch already downgrades POST to GET on a
 * 302 per spec, so plain redirect following is exactly right here. Re-sending
 * the POST to that redirect gets you an HTML page instead of your data.
 */
async function rpc(payload) {
  if (!SCRIPT_URL) throw new Error('APPS_SCRIPT_URL is not set');

  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids an Apps Script CORS preflight
    body: JSON.stringify({ ...payload, secret: SCRIPT_SECRET }),
    redirect: 'follow',
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Show what actually came back — a sign-in page and a script error look
    // nothing alike, and guessing between them wastes an afternoon.
    const clue = /accounts\.google\.com|sign in|signin/i.test(text)
      ? 'Got a Google sign-in page: set "Who has access" to Anyone, then redeploy as a NEW version.'
      : `Got ${res.status}: ${text.slice(0, 140).replace(/\s+/g, ' ')}`;
    throw new Error('Bridge returned non-JSON. ' + clue);
  }
  if (data.error) {
    // The bridge answering but not knowing the verb means the live deployment
    // is older than the code — the single most common failure in this setup.
    if (data.error === 'unknown_action') {
      throw new Error('The Apps Script bridge is running an old version. In the editor: ' +
        'Deploy \u2192 Manage deployments \u2192 pencil \u2192 Version: New version \u2192 Deploy.');
    }
    throw new Error('Bridge: ' + data.error);
  }
  return data;
}

const tabNames = sheet => rpc({ action: 'tabs', sheet }).then(d => d.tabs);
const grid = (sheet, tab) => rpc({ action: 'grid', sheet, tab }).then(d => d.values || []);
const updateRange = (sheet, tab, range, values) => rpc({ action: 'update', sheet, tab, range, values });
const appendRow = (sheet, tab, row, notify) => rpc({ action: 'append', sheet, tab, row, notify });
const deleteRow = (sheet, tab, rowIndex) => rpc({ action: 'delete', sheet, tab, rowIndex });

/* ------------------------------------------------------- cache (no DB yet) */

const cache = { curriculum: null, programming: null, notation: null, at: 0 };
const TTL_MS = 5 * 60 * 1000; // shortened from 15 — Kendall needs changes visible sooner.
async function warm(force = false) {
  if (!force && cache.at && Date.now() - cache.at < TTL_MS) return;
  const [curr, prog, news, staff, sched, changes] = await Promise.all([
    loadCurriculum(), loadProgramming(), loadAnnouncements(),
    loadStaff(), loadSchedule(), loadChanges(),
  ]);
  cache.news = news; cache.staff = staff; cache.schedule = sched; cache.changes = changes;
  cache.events = await loadEvents();
  cache.curriculum = curr.towers;
  cache.notation = curr.notation;
  cache.weekTitle = curr.weekTitle;
  cache.programming = prog;
  cache.at = Date.now();
}
setInterval(() => warm(true).catch(e => console.error('refresh failed', e.message)), TTL_MS);

/* ------------------------------------------------------------------ staff */

/** Reads a tab, tolerating it not existing yet. */
async function readTab(sheet, tab) {
  try {
    const tabs = await tabNames(sheet);
    if (!tabs.includes(tab)) return [];
    return (await grid(sheet, tab)).slice(1);
  } catch (e) {
    console.error(`${tab}:`, e.message);
    return [];
  }
}

/** The registry every coach lands in at intake. Email is the identity key. */
async function loadStaff() {
  return (await readTab(CURRICULUM, 'Staff'))
    .map((r, i) => ({
      row: i + 2, name: cell(r, 0), email: cell(r, 1).toLowerCase(),
      phone: cell(r, 2), joined: cell(r, 3),
    }))
    .filter(s => s.email);
}

/**
 * The gym's standing week, built in. The app shows the real schedule from the
 * first load; a `Schedule` tab in Master Control overrides this once one
 * exists, so nothing has to be set up before anyone can use it.
 */
const DEFAULT_SCHEDULE = [
  { day: 'Monday', time: '5:15 AM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Monday', time: '6:00 AM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Monday', time: '7:00 AM', klass: 'Express 35', coach: 'David Clark', assisting: '' },
  { day: 'Monday', time: '9:00 AM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Monday', time: '4:30 PM', klass: 'The Gauntlet 45', coach: 'Kendal Harris', assisting: '' },
  { day: 'Monday', time: '5:30 PM', klass: 'The Gauntlet 45', coach: 'Kendal Harris', assisting: '' },
  { day: 'Tuesday', time: '5:15 AM', klass: 'The Gauntlet 45', coach: 'Paul Shunnarah', assisting: '' },
  { day: 'Tuesday', time: '6:00 AM', klass: 'Strength 45', coach: 'Paul Shunnarah', assisting: '' },
  { day: 'Tuesday', time: '12:00 PM', klass: 'Express 35', coach: 'David Clark', assisting: '' },
  { day: 'Tuesday', time: '4:30 PM', klass: 'The Gauntlet 45', coach: 'Kendall Lindsey', assisting: '' },
  { day: 'Tuesday', time: '5:30 PM', klass: 'Strength 45', coach: 'Kendall Lindsey', assisting: '' },
  { day: 'Wednesday', time: '5:15 AM', klass: 'The Gauntlet 45', coach: 'Paul Shunnarah', assisting: '' },
  { day: 'Wednesday', time: '6:00 AM', klass: 'The Gauntlet 45', coach: 'Paul Shunnarah', assisting: '' },
  { day: 'Wednesday', time: '7:00 AM', klass: 'Express 35', coach: 'Paul Shunnarah', assisting: '' },
  { day: 'Wednesday', time: '9:00 AM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Wednesday', time: '4:30 PM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Wednesday', time: '5:30 PM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Thursday', time: '6:00 AM', klass: 'Strength 45', coach: 'Kendal Harris', assisting: '' },
  { day: 'Thursday', time: '12:00 PM', klass: 'Express 35', coach: 'David Clark', assisting: '' },
  { day: 'Thursday', time: '4:30 PM', klass: 'The Gauntlet 45', coach: 'Kendall Waldrop', assisting: '' },
  { day: 'Thursday', time: '5:30 PM', klass: 'The Gauntlet 45', coach: 'Kendall Waldrop', assisting: '' },
  { day: 'Friday', time: '6:00 AM', klass: 'The Gauntlet 45', coach: 'Kendal Harris', assisting: '' },
  { day: 'Friday', time: '7:00 AM', klass: 'Express 35', coach: 'Kendal Harris', assisting: '' },
  { day: 'Friday', time: '9:00 AM', klass: 'The Gauntlet 45', coach: 'David Clark', assisting: '' },
  { day: 'Friday', time: '12:00 PM', klass: 'Express 35', coach: 'David Clark', assisting: '' },
  { day: 'Saturday', time: '9:00 AM', klass: 'Red Bull Slay & Soda', coach: 'April Mack', assisting: '' }
];

/**
 * The standing weekly grid. Class is optional — the paper schedule identifies
 * slots by time and coach alone, so requiring a class name would mean typing
 * "Muay Thai" into forty rows that never say it.
 */
async function loadSchedule() {
  const rows = (await readTab(CURRICULUM, 'Schedule'))
    .map((r, i) => ({
      row: i + 2, day: cell(r, 0), time: cell(r, 1),
      klass: cell(r, 2), coach: cell(r, 3), assisting: cell(r, 4),
    }))
    .filter(s => s.day && s.time);

  // No tab yet: fall back to the built-in week. row === null marks these as
  // not editable, since there's no sheet row behind them to write to.
  return rows.length ? rows : DEFAULT_SCHEDULE.map(s => ({ ...s, row: null, builtin: true }));
}


/**
 * One-offs that aren't a standing shift: an off-site event with several
 * coaches, an admin meeting, or a cancelled class. Kind is Event, Meeting or
 * Closed — a closure hides the standing slot for that date only.
 */
async function loadEvents() {
  return (await readTab(CURRICULUM, 'Events'))
    .map((r, i) => ({
      row: i + 2, date: cell(r, 0), time: cell(r, 1), title: cell(r, 2),
      who: cell(r, 3), location: cell(r, 4), kind: cell(r, 5) || 'Event',
    }))
    .filter(e => e.date && e.title);
}

/** Dated exceptions. A swap writes here, never into the standing grid. */
async function loadChanges() {
  return (await readTab(CURRICULUM, 'Shift Changes'))
    .map((r, i) => ({
      row: i + 2, date: cell(r, 0), time: cell(r, 1), klass: cell(r, 2),
      from: cell(r, 3), to: cell(r, 4), type: cell(r, 5),
      status: cell(r, 6), note: cell(r, 7),
      // Added rows carry their own slot; they aren't overrides of anything.
    }))
    .filter(c => c.date && c.time);
}

/** "5:15am" / "12:00pm" / "4:30 PM" -> minutes past midnight, for sorting. */
function mins(t) {
  const m = String(t || '').match(/(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
  if (!m) return 9999;
  let h = Number(m[1]) % 12;
  if (/p/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2] || 0);
}

/**
 * The standing grid for that weekday with dated exceptions layered on top:
 * cancellations greyed out, one-off classes inserted, covers reassigned.
 * Sorted by clock time, since the sheet rows aren't in time order.
 */
function scheduleFor(dateStr) {
  const day = DAYS[new Date(dateStr + 'T12:00:00').getDay()];
  const changes = (cache.changes || []).filter(c => c.date === dateStr);
  const closures = (cache.events || []).filter(e => e.date === dateStr && /^closed$/i.test(e.kind));
  const match = (c, s) => c.time === s.time && (c.klass || '') === (s.klass || '');

  const standing = (cache.schedule || []).filter(s => s.day === day).map(s => {
    const cancelled = changes.find(c => match(c, s) && /^cancel/i.test(c.type));
    const filled = changes.find(c => match(c, s) && /^(accepted|filled)$/i.test(c.status));
    const pending = changes.find(c => match(c, s) && /^(open|pending)$/i.test(c.status));
    const closed = closures.find(c => !c.time || c.time === s.time);
    return {
      ...s,
      coach: filled ? filled.to : s.coach,
      covered: !!filled,
      closed: closed ? closed.title : null,
      cancelled: !!cancelled,
      cancelRow: cancelled ? cancelled.row : null,
      cancelNote: cancelled ? (cancelled.note || 'No class') : '',
      request: pending ? { row: pending.row, type: pending.type, from: pending.from, to: pending.to, note: pending.note } : null,
    };
  });

  // A pop-up class exists only on its date, so it lives in the change log
  // rather than the standing grid.
  const oneOffs = changes.filter(c => /^added$/i.test(c.type)).map(c => ({
    row: null, changeRow: c.row, day, time: c.time, klass: c.klass,
    coach: c.to || c.from, assisting: '', oneOff: true,
    covered: false, cancelled: false, cancelNote: '', closed: null, request: null,
  }));

  return [...standing, ...oneOffs].sort((a, b) => mins(a.time) - mins(b.time));
}

/* ------------------------------------------------------------ announcements */

/**
 * Reads the Announcements tab, newest first, dropping anything past its
 * expiry. Missing tab is not an error — it just means nobody's posted yet.
 */
async function loadAnnouncements() {
  try {
    const tabs = await tabNames(CURRICULUM);
    if (!tabs.includes('Announcements')) return [];
    const rows = await grid(CURRICULUM, 'Announcements');
    const today = new Date(); today.setHours(0, 0, 0, 0);

    return rows.slice(1).map(r => ({
      posted: cell(r, 0), by: cell(r, 1),
      title: cell(r, 2), message: cell(r, 3), expires: cell(r, 4),
    })).filter(a => {
      if (!a.title && !a.message) return false;
      if (!a.expires) return true;
      const d = new Date(a.expires);
      return isNaN(d) || d >= today;
    }).reverse();
  } catch (e) {
    console.error('announcements:', e.message);
    return [];
  }
}

/* --------------------------------------------------- curriculum (combos) */

const cell = (row, i) => (row && row[i] != null ? String(row[i]).trim() : '');

async function loadCurriculum() {
  const tabs = await tabNames(CURRICULUM);
  const scheduleTab = tabs.find(t => /master\s*schedule/i.test(t)) || tabs[0];
  const keyTab = tabs.find(t => /notation/i.test(t));

  const rows = await grid(CURRICULUM, scheduleTab);

  // Title banner, e.g. "WEEK 7: DOUBLE-PUMP PRESSURE" — shown so a coach can
  // see at a glance whether they're looking at current work.
  let weekTitle = '';
  for (const r of rows.slice(0, 4)) {
    const t = r.find(v => v && /week/i.test(String(v)));
    if (t) { weekTitle = String(t).trim(); break; }
  }

  const headerIdx = rows.findIndex(r =>
    cell(r, 0).toLowerCase() === 'tower' && r.some(v => /^monday$/i.test(String(v || '').trim())));
  if (headerIdx < 0) throw new Error('Master Schedule: no Tower/Monday header row found');
  const header = rows[headerIdx].map(v => String(v || '').trim());

  // Tower names are merged across the tier rows, so only the first row of each
  // group carries a value. Carry it forward or two towers in three go unlabeled.
  const towers = {};
  let current = null;
  for (const row of rows.slice(headerIdx + 1)) {
    const name = cell(row, 0);
    if (name) current = name;
    const tier = cell(row, 1).toUpperCase();
    if (!current || !/^(BLUE|BLACK)$/.test(tier)) continue; // WHITE is handled elsewhere — never parsed here.
    towers[current] = towers[current] || { tower: current, BLUE: {}, BLACK: {} };
    for (let d = 1; d <= 6; d++) {
      const col = header.findIndex(h => h.toLowerCase() === DAYS[d].toLowerCase());
      if (col < 0) continue;
      towers[current][tier][DAYS[d]] = cell(row, col).replace(/\\n/g, '\n');
    }
  }

  const notation = keyTab ? parseNotation(await grid(CURRICULUM, keyTab)) : {};
  return { towers: Object.values(towers), notation, weekTitle };
}

function parseNotation(rows) {
  const map = {};
  for (const row of rows) {
    // Key is laid out as repeating CODE | MEANING pairs across the row.
    for (let i = 0; i + 1 < row.length; i += 2) {
      const code = cell(row, i), meaning = cell(row, i + 1);
      if (!code || !meaning || /^code$/i.test(code)) continue;
      map[normalizeToken(code)] = meaning;
    }
  }
  return map;
}

/**
 * The schedule and the key don't spell tokens the same way: the key defines
 * L/BLOCK, the schedule writes BLOCK L; the key has L/UP ELBOW, the schedule
 * writes L/UP-ELBOW. Normalizing both sides beats hand-expanding the key.
 */
function normalizeToken(raw) {
  let t = String(raw).toUpperCase().trim();
  t = t.replace(/[-_]+/g, ' ').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
  t = t.replace(/\bELBOW\b/g, '').trim();          // L/SLASH ELBOW -> L/SLASH
  t = t.replace(/^(LOW|HIGH|BODY|STEP)\s+/, '');    // modifiers aren't separate moves
  const m = t.match(/^BLOCK\s+([LR])$/);            // BLOCK L -> L/BLOCK
  if (m) t = `${m[1]}/BLOCK`;
  const c = t.match(/^CHECK\s+([LR])$/);
  if (c) t = `CHECK ${c[1]}`;
  return t;
}

/**
 * Splits a combo string into tokens and attaches a meaning where one exists.
 * Anything unmatched comes back as plain text — a token that taps and says
 * nothing is worse than one that doesn't look tappable.
 */
function tokenize(combo, notation) {
  if (!combo) return [];
  return combo.split('\n').map(line =>
    line.split(/\s{2,}|\s+-\s+/).filter(Boolean).flatMap(chunk => {
      const parts = chunk.trim().split(/\s+/);
      const out = [];
      for (let i = 0; i < parts.length; i++) {
        // Greedy: try the longest run of words that resolves to a known code.
        let hit = null;
        for (let len = Math.min(3, parts.length - i); len >= 1; len--) {
          const phrase = parts.slice(i, i + len).join(' ');
          const meaning = notation[normalizeToken(phrase)];
          if (meaning) { hit = { text: phrase, meaning, len }; break; }
        }
        if (hit) { out.push({ text: hit.text, meaning: hit.meaning }); i += hit.len - 1; }
        else out.push({ text: parts[i], meaning: null });
      }
      return out;
    }));
}

/* ------------------------------------------------- programming (workouts) */

const PLACEHOLDER = /^(?:exercise\s*\d*\s*:?\s*)+$/i;
const isBlank = v => !v || !v.trim() || PLACEHOLDER.test(v.trim());

async function loadProgramming() {
  const tabs = await tabNames(PROGRAMMING);
  const month = MONTHS[new Date().getMonth()];
  const tab = tabs.find(t => new RegExp(`^${month}`, 'i').test(t.trim()));
  if (!tab) return { month, tab: null, weeks: [] };

  const rows = await grid(PROGRAMMING, tab);
  const weeks = [];
  let block = null;

  rows.forEach((row, idx) => {
    const first = cell(row, 0);
    const wk = first.match(/^week\s*(\d+)/i);
    if (wk) {
      block = { label: first, number: Number(wk[1]), rowIndex: idx, days: {}, sections: {}, statusRow: null };
      weeks.push(block);
      return;
    }
    if (!block) return;

    if (/^section$/i.test(first)) {
      // "Monday Squat + Push Emphasis Full Body" -> column for Monday
      row.forEach((v, i) => {
        const label = String(v || '').trim();
        const day = DAYS.find(d => new RegExp(`^${d}\\b`, 'i').test(label));
        if (day) block.days[day] = { col: i, focus: label.replace(new RegExp(`^${day}\\s*`, 'i'), '') };
      });
      return;
    }
    // Row labels are NOT consistent between blocks (July W3 has no Coaching
    // Cues row at all), so key on the label in column A, never a row offset.
    if (first) {
      block.sections[first] = row;
      if (/^status$/i.test(first)) block.statusRow = idx;
    }
  });

  return { month, tab, weeks };
}

/** Which week block is live. A confirmation wins; otherwise best guess, flagged. */
function pickWeek(prog, today = new Date()) {
  if (!prog.weeks.length) return { week: null, confirmed: false, by: null };

  const confirmed = prog.weeks.filter(w => {
    const s = cell(w.sections['Status'] || [], 1);
    return /^confirmed/i.test(s);
  });
  if (confirmed.length) {
    const w = confirmed[confirmed.length - 1];
    const s = cell(w.sections['Status'], 1);
    return { week: w, confirmed: true, by: s.replace(/^confirmed\s*(by)?\s*/i, '') };
  }

  // Fallback: which Monday-week of the month are we in. Anchor on the first
  // Monday, not the 1st — a month starting Sat/Sun would otherwise count that
  // stray weekend as week 1 and shift every block forward by one.
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstMonday = 1 + ((8 - first.getDay()) % 7 || 7) % 7;
  const n = Math.max(1, Math.floor((today.getDate() - firstMonday) / 7) + 1);

  // Prefer the block actually labelled "Week n"; index math breaks on tabs
  // whose blocks don't start at 1 (July runs Week 3-5).
  const byLabel = prog.weeks.find(w => w.number === n);
  const week = byLabel || prog.weeks[Math.min(n - 1, prog.weeks.length - 1)];
  return { week, confirmed: false, by: null };
}

function workoutFor(week, day) {
  if (!week || !week.days[day]) return null;
  const col = week.days[day].col;
  const get = label => {
    const key = Object.keys(week.sections).find(k => k.toLowerCase() === label.toLowerCase());
    return key ? cell(week.sections[key], col) : '';
  };
  const main = get('Main Workout / Flow');
  return {
    focus: week.days[day].focus,
    name: get('Workout Name'),
    status: get('Status'),
    warmUp: get('Warm-Up'),
    main,
    finisher: get('Finisher'),
    cues: get('Coaching Cues'),
    equipment: get('Equipment Needed'),
    notes: get('Coach Notes / Edits'),
    empty: isBlank(main),
  };
}

/* ------------------------------------------------------------------ API */

app.get('/api/day', async (req, res) => {
  try {
    await warm();
    const day = DAYS.includes(req.query.day) ? req.query.day : DAYS[new Date().getDay()];
    const prog = cache.programming;
    const { week, confirmed, by } = pickWeek(prog);

    let workout = null, saturday = false;
    if (day === 'Saturday') saturday = true;          // coach-led, never programmed
    else if (day !== 'Sunday') workout = workoutFor(week, day);

    res.json({
      day,
      weekTitle: cache.weekTitle,
      updatedAt: new Date(cache.at).toISOString(),
      announcements: cache.news || [],
      towers: cache.curriculum.map(t => ({
        tower: t.tower,
        BLUE: tokenize(t.BLUE[day], cache.notation),
        BLACK: tokenize(t.BLACK[day], cache.notation),
      })),
      programming: {
        month: prog.month,
        weekLabel: week ? week.label : null,
        confirmed, confirmedBy: by,
        saturday,
        workout,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/** What Kendall or Ivan sees before they confirm — all five days, as coaches get them. */
app.get('/api/week/review', async (req, res) => {
  try {
    await warm();
    const prog = cache.programming;
    const { week } = pickWeek(prog);
    if (!week) return res.json({ week: null, days: [] });
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
      .map(d => ({ day: d, ...(workoutFor(week, d) || { empty: true }) }));
    res.json({
      month: prog.month,
      weekLabel: week.label,
      days,
      blocking: days.filter(d => d.empty).map(d => d.day),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/week/confirm', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!CONFIRMERS.includes(email)) return res.status(403).json({ error: 'Not on the confirm list.' });

    await warm(true);
    const prog = cache.programming;
    const { week } = pickWeek(prog);
    if (!week || week.statusRow == null) return res.status(400).json({ error: 'No week block to confirm.' });

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const empty = days.filter(d => (workoutFor(week, d) || { empty: true }).empty);
    if (empty.length && !req.body.force) {
      return res.status(409).json({ error: 'empty_days', days: empty });
    }

    const stamp = `Confirmed by ${email.split('@')[0]} ${new Date().toLocaleDateString('en-US')}`;
    const cols = days.map(d => week.days[d] && week.days[d].col).filter(c => c != null);
    const startCol = Math.min(...cols), endCol = Math.max(...cols);
    const a1 = (c) => {
      let s = '', n = c + 1;
      while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
      return s;
    };
    await updateRange(
      PROGRAMMING,
      prog.tab,
      `${a1(startCol)}${week.statusRow + 1}:${a1(endCol)}${week.statusRow + 1}`,
      [cols.map(() => stamp)],
    );

    await warm(true);
    res.json({ ok: true, weekLabel: week.label, stamp });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------------------------------------- write actions */

const LABEL = { repair: 'Repair', swap: 'Shift swap', note: 'Coach note' };

/** Repair notes, swap requests, coach notes — one log, one notification. */
app.post('/api/request', async (req, res) => {
  try {
    const type = LABEL[req.body.type] ? req.body.type : 'note';
    const from = String(req.body.from || '').trim();
    const details = String(req.body.details || '').trim();
    if (!details) return res.status(400).json({ error: 'Say what you need — the note is empty.' });
    if (!from) return res.status(400).json({ error: 'Add your name so somebody knows who to answer.' });

    const when = new Date().toLocaleString('en-US');
    await appendRow(CURRICULUM, 'Requests', [when, LABEL[type], from, details, 'Open'], {
      subject: `[Gauntlet] ${LABEL[type]} — ${from}`,
      body: `${from} submitted a ${LABEL[type].toLowerCase()} on ${when}:\n\n${details}`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/announcements', async (_, res) => {
  try { await warm(); res.json({ announcements: cache.news || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/announcements', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!ANNOUNCERS.includes(email)) return res.status(403).json({ error: 'Not on the announcements list.' });

    const title = String(req.body.title || '').trim();
    const message = String(req.body.message || '').trim();
    if (!title) return res.status(400).json({ error: 'Give it a headline.' });

    const expires = String(req.body.expires || '').trim();
    await appendRow(CURRICULUM, 'Announcements',
      [new Date().toLocaleDateString('en-US'), email.split('@')[0], title, message, expires]);

    await warm(true);
    res.json({ ok: true, announcements: cache.news || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/whoami', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  try { await warm(); } catch {}
  const me = (cache.staff || []).find(s => s.email === email) || null;
  res.json({
    known: !!me, me,
    canConfirm: CONFIRMERS.includes(email),
    canAnnounce: ANNOUNCERS.includes(email),
    canSchedule: SCHEDULERS.includes(email),
  });
});

/* ---------------------------------------------------- staff and schedule */

/** Intake. Registering twice updates the record instead of duplicating it. */
app.post('/api/staff', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').toLowerCase().trim();
    const phone = String(req.body.phone || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right.' });

    await warm();
    // Two Kendalls is a real case here. Shifts are matched by display name, so
    // a name collision would let one coach see another's shifts as their own.
    const nameTaken = (cache.staff || []).find(s =>
      s.name.toLowerCase() === name.toLowerCase() && s.email !== email);
    if (nameTaken) return res.status(409).json({
      error: `Somebody already goes by "${name}". Add a last name or initial so shifts don't get crossed.`,
    });

    const existing = (cache.staff || []).find(s => s.email === email);
    if (existing) {
      await updateRange(CURRICULUM, 'Staff', `A${existing.row}:C${existing.row}`, [[name, email, phone]]);
    } else {
      await appendRow(CURRICULUM, 'Staff', [name, email, phone, new Date().toLocaleDateString('en-US')]);
    }
    await warm(true);
    res.json({ ok: true, me: (cache.staff || []).find(s => s.email === email) || null });
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message });
  }
});

/** Seven days at once — how a scheduler actually thinks about the week. */
app.get('/api/week', async (req, res) => {
  try {
    await warm();
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '')
      ? new Date(req.query.start + 'T12:00:00') : new Date();
    // Back up to Monday; the paper schedule runs Monday through Sunday.
    const monday = new Date(anchor);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const date = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
      days.push({
        date, day: DAYS[d.getDay()], label: d.getDate(),
        slots: scheduleFor(date),
        events: (cache.events || []).filter(e => e.date === date && !/^closed$/i.test(e.kind)),
      });
    }
    res.json({ start: days[0].date, end: days[6].date, days, staff: (cache.staff || []).map(s => s.name) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message });
  }
});

app.get('/api/schedule', async (req, res) => {
  try {
    await warm();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || req.query.date || '')
      ? (req.query.date) : new Date().toISOString().slice(0, 10);
    res.json({
      date,
      slots: scheduleFor(date),
      events: (cache.events || []).filter(e => e.date === date && !/^closed$/i.test(e.kind)),
      staff: (cache.staff || []).map(s => s.name),
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message });
  }
});

/** Kendall adding a class slot to the standing weekly grid. */
app.post('/api/schedule/slot', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can change the schedule.' });
    const { day, time, klass, coach } = req.body;
    if (!day || !time) return res.status(400).json({ error: 'Day and time are needed.' });
    await appendRow(CURRICULUM, 'Schedule', [day, time, klass || '', coach || '']);
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Tap a slot, pick a name. Same interaction on a laptop and a phone. */
app.post('/api/schedule/assign', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can assign coaches.' });
    const row = Number(req.body.row);
    if (!row) return res.status(400).json({ error: 'Which slot?' });
    await updateRange(CURRICULUM, 'Schedule', `D${row}:D${row}`, [[String(req.body.coach || '')]]);
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Edit a standing slot — retime it, relabel it, or reassign it. */
app.post('/api/schedule/slot/update', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can change the schedule.' });
    const row = Number(req.body.row);
    if (!row) return res.status(400).json({ error: 'Which slot?' });
    const { day, time, klass, coach } = req.body;
    if (!day || !time) return res.status(400).json({ error: 'Day and time are needed.' });
    await updateRange(CURRICULUM, 'Schedule', `A${row}:E${row}`,
      [[day, time, klass || '', coach || '', req.body.assisting || '']]);
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/schedule/slot/delete', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can change the schedule.' });
    const row = Number(req.body.row);
    if (!row) return res.status(400).json({ error: 'Which slot?' });
    await deleteRow(CURRICULUM, 'Schedule', row);
    await warm(true);   // row numbers shift after a delete — never reuse the old ones
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * "NO NOON CLASS" — kills a slot for one date only. Deliberately separate from
 * deleting the slot: one is this week, the other is forever, and confusing the
 * two costs you a class nobody shows up to teach.
 */
app.post('/api/schedule/cancel', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can cancel a class.' });
    const { date, time, klass, note } = req.body;
    if (!date || !time) return res.status(400).json({ error: 'Which class, which date?' });
    await appendRow(CURRICULUM, 'Shift Changes',
      [date, time, klass || '', '', '', 'Cancelled', 'Cancelled', note || 'No class']);
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Undo a cancellation, or clear a stale request, by dropping the log row. */
app.post('/api/schedule/restore', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can restore a class.' });
    await deleteRow(CURRICULUM, 'Shift Changes', Number(req.body.row));
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** A pop-up class on one date — never touches the standing weekly grid. */
app.post('/api/schedule/oneoff', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can add a class.' });
    const { date, time, klass, coach, note } = req.body;
    if (!date || !time) return res.status(400).json({ error: 'A date and a time, at minimum.' });
    await appendRow(CURRICULUM, 'Shift Changes',
      [date, time, klass || '', coach || '', coach || '', 'Added', 'Added', note || '']);
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ----------------------------------------------------------------- events */

app.post('/api/events', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can add events.' });
    const { date, time, title, location } = req.body;
    if (!date || !title) return res.status(400).json({ error: 'A date and a name, at minimum.' });
    const kind = ['Event', 'Meeting', 'Closed'].includes(req.body.kind) ? req.body.kind : 'Event';
    const who = Array.isArray(req.body.who) ? req.body.who.join(', ') : String(req.body.who || '');
    await appendRow(CURRICULUM, 'Events',
      [date, time || '', title, who, location || '', kind]);
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events/delete', async (req, res) => {
  try {
    if (!SCHEDULERS.includes(String(req.body.email || '').toLowerCase().trim()))
      return res.status(403).json({ error: 'Only schedulers can remove events.' });
    await deleteRow(CURRICULUM, 'Events', Number(req.body.row));
    await warm(true);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------------------------------------------ swaps */

/**
 * Two different transactions. A cover is an open offer to everyone; a trade is
 * aimed at one person. They notify different people and resolve differently,
 * so they're separate rather than one ambiguous button.
 */
app.post('/api/swap', async (req, res) => {
  try {
    await warm();
    const email = String(req.body.email || '').toLowerCase().trim();
    const me = (cache.staff || []).find(s => s.email === email);
    if (!me) return res.status(403).json({ error: 'Finish setup first so people know who is asking.' });

    const { date, time, klass, note } = req.body;
    const type = req.body.type === 'trade' ? 'trade' : 'cover';
    if (!date || !time) return res.status(400).json({ error: 'Pick a shift first.' });

    const target = type === 'trade' ? String(req.body.target || '').trim() : '';
    if (type === 'trade' && !target) return res.status(400).json({ error: 'Who are you asking?' });

    const dupe = (cache.changes || []).find(c =>
      c.date === date && c.time === time && c.klass === klass && /^(open|pending)$/i.test(c.status));
    if (dupe) return res.status(409).json({ error: 'There is already an open request on that shift.' });

    await appendRow(CURRICULUM, 'Shift Changes',
      [date, time, klass, me.name, target, type === 'trade' ? 'Trade' : 'Cover',
       type === 'trade' ? 'Pending' : 'Open', String(note || '')],
      {
        subject: `[Gauntlet] ${me.name} needs ${date} ${time} ${klass} covered`,
        body: `${me.name} asked for a ${type} on ${date} at ${time} (${klass}).` +
              (target ? `\nAimed at: ${target}` : '\nOpen to anyone.') +
              (note ? `\n\n"${note}"` : ''),
      });
    await warm(true);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message });
  }
});

/** Whoever taps first takes it. The re-read is what stops two people claiming one shift. */
app.post('/api/swap/accept', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    await warm(true);
    const me = (cache.staff || []).find(s => s.email === email);
    if (!me) return res.status(403).json({ error: 'Finish setup first.' });

    const change = (cache.changes || []).find(c => c.row === Number(req.body.row));
    if (!change) return res.status(404).json({ error: 'That request is gone.' });
    if (!/^(open|pending)$/i.test(change.status))
      return res.status(409).json({ error: `Already ${change.status.toLowerCase()} — somebody beat you to it.` });
    if (change.from === me.name) return res.status(400).json({ error: 'That is your own request.' });

    await updateRange(CURRICULUM, 'Shift Changes', `E${change.row}:G${change.row}`,
      [[me.name, change.type, change.type.toLowerCase() === 'trade' ? 'Accepted' : 'Filled']]);
    await appendRow(CURRICULUM, 'Requests',
      [new Date().toLocaleString('en-US'), 'Swap filled', me.name,
       `${me.name} took ${change.from}'s ${change.date} ${change.time} ${change.klass}`, 'Closed'],
      {
        subject: `[Gauntlet] ${me.name} is covering ${change.date} ${change.time}`,
        body: `${me.name} accepted ${change.from}'s ${change.klass} shift on ${change.date} at ${change.time}.`,
      });
    await warm(true);
    res.json({ ok: true });
  } catch (e) {
    console.error(e); res.status(500).json({ error: e.message });
  }
});

app.get('/healthz', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Gauntlet Coach on :${PORT}`));
