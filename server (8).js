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
 *   TV_URL               (optional) the lobby TV Worker. Defaults to
 *                        https://gauntlet-bingo.dangerdave1914.workers.dev
 *   PORT                 (App Platform sets this automatically)
 */

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;
const TV_URL = (process.env.TV_URL || 'https://gauntlet-bingo.dangerdave1914.workers.dev').replace(/\/+$/, '');
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

const cache = { curriculum: null, programming: null, notation: null, settings: null, at: 0 };
const TTL_MS = 5 * 60 * 1000; // shortened from 15 — Kendall needs changes visible sooner.
async function warm(force = false) {
  if (!force && cache.at && Date.now() - cache.at < TTL_MS) return;
  const settings = await loadSettings();
  cache.settings = settings;
  const [curr, prog, news, staff, sched, changes, notes] = await Promise.all([
    loadCurriculum(), loadProgramming(settings), loadAnnouncements(),
    loadStaff(), loadSchedule(), loadChanges(), loadNotes(),
  ]);
  cache.news = news; cache.staff = staff; cache.schedule = sched; cache.changes = changes;
  cache.notes = notes;
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

/* ------------------------------------------------------------ coach notes */

/**
 * Coach notes and repair flags, from the Requests tab the Coach note button
 * already writes to. Swap bookkeeping rows ("Swap filled") live in the same
 * tab but aren't notes, so they stay out. Newest first.
 */
const NOTE_TYPES = /^(coach note|repair)$/i;
async function loadNotes() {
  return (await readTab(CURRICULUM, 'Requests'))
    .map((r, i) => ({
      row: i + 2, when: cell(r, 0), type: cell(r, 1), from: cell(r, 2),
      details: cell(r, 3), status: cell(r, 4) || 'Open',
    }))
    .filter(n => n.details && NOTE_TYPES.test(n.type))
    .reverse()
    .slice(0, 60);
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
    for (let d = 0; d <= 6; d++) {   // Sunday included whenever the sheet has a Sunday column
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

/* -------------------------------------------------- app settings (Key/Value) */

const SETTINGS_TAB = 'Settings';
const ACTIVE_TAB_KEY = 'ActiveMonthTab';

/** Small Key/Value store on the Programming sheet. Empty until first write —
 *  that's not an error, it just means nothing's been overridden yet. */
async function loadSettings() {
  try {
    const rows = await grid(PROGRAMMING, SETTINGS_TAB);
    const map = {};
    rows.slice(1).forEach(r => { if (r[0]) map[String(r[0]).trim()] = String(r[1] || '').trim(); });
    return map;
  } catch {
    return {};
  }
}

/** Updates a key in place if the row exists, otherwise appends it (which also
 *  creates the tab with headers the first time, via Code.gs's LOGS map). */
async function writeSetting(key, value) {
  let rows = [];
  try { rows = await grid(PROGRAMMING, SETTINGS_TAB); } catch { /* tab doesn't exist yet */ }
  const idx = rows.findIndex((r, i) => i > 0 && String(r[0]).trim() === key);
  if (idx > 0) await updateRange(PROGRAMMING, SETTINGS_TAB, `B${idx + 1}`, [[value]]);
  else await appendRow(PROGRAMMING, SETTINGS_TAB, [key, value]);
}

/* ------------------------------------------------- programming (workouts) */

const PLACEHOLDER = /^(?:exercise\s*\d*\s*:?\s*)+$/i;
const isBlank = v => !v || !v.trim() || PLACEHOLDER.test(v.trim());

/**
 * Which Programming tab is "live". Defaults to whichever tab starts with the
 * current calendar month — so it resets itself automatically on rollover,
 * with zero upkeep. A scheduler can override that via ActiveMonthTab in the
 * Settings tab (set through the app, not by hand) when the team is working
 * ahead of the calendar; clearing the override goes straight back to auto.
 */
async function loadProgramming(settings = {}) {
  const tabs = await tabNames(PROGRAMMING);
  const calendarMonth = MONTHS[new Date().getMonth()];
  const autoTab = tabs.find(t => new RegExp(`^${calendarMonth}`, 'i').test(t.trim()));
  const monthTabs = tabs.filter(t => MONTHS.some(m => new RegExp(`^${m}`, 'i').test(t.trim())));

  const requestedOverride = (settings[ACTIVE_TAB_KEY] || '').trim();
  const overrideTab = requestedOverride && tabs.includes(requestedOverride) ? requestedOverride : null;
  const tab = overrideTab || autoTab;

  if (!tab) return { month: calendarMonth, tab: null, weeks: [], monthTabs, autoTab, overrideTab };

  const rows = await grid(PROGRAMMING, tab);
  const weeks = parseWeeks(rows);
  return { month: calendarMonth, tab, weeks, monthTabs, autoTab, overrideTab };
}

/**
 * Splits a programming tab into its Week blocks. A day header can carry a
 * date — "Monday 10/26" — and when it does, that column belongs to that date
 * no matter which tab or week block it sits in. That's how a one-off tab like
 * HALLOWEEN WEEK takes over its own dates.
 */
function parseWeeks(rows) {
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
        if (!day) return;
        const dm = label.match(new RegExp(`^${day}\\s+(\\d{1,2})\\/(\\d{1,2})`, 'i'));
        block.days[day] = {
          col: i,
          md: dm ? `${Number(dm[1])}/${Number(dm[2])}` : null,
          focus: label.replace(new RegExp(`^${day}\\s*(\\d{1,2}\\/\\d{1,2})?\\s*`, 'i'), ''),
        };
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
  return weeks;
}

/** Which week block is live: the first one with any day still marked Ready.
 *  Falls back to the calendar guess if nothing is Ready. */
function pickWeek(prog) {
  if (!prog || !prog.weeks.length) return { week: null, confirmed: false, by: null };

  const isReady = w => {
    const key = Object.keys(w.sections).find(k => /^status$/i.test(k));
    return key && w.sections[key].slice(1).some(v => /^ready/i.test(String(v || '').trim()));
  };
  const ready = prog.weeks.find(isReady);
  if (ready) return { week: ready, confirmed: true, by: null };

  // Fallback: which Monday-week of the month are we in. Anchor on the first
  // Monday, not the 1st — a month starting Sat/Sun would otherwise count that
  // stray weekend as week 1 and shift every block forward by one.
  const today = new Date();
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

/* ------------------------------------------------- any date, any week ---- */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Today's date in the gym's time zone, as YYYY-MM-DD. */
const gymToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const mondayOf = iso => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const sameWeek = (a, b) => mondayOf(a) === mondayOf(b);

/** Every programming tab with workouts in it, read together and kept 10 minutes.
 *  Only needed when someone looks at a day outside this week, so it loads then. */
const ALL_PROG_TTL = 10 * 60 * 1000;
const NOT_PROGRAMMING = /^(start here|tv display|weekend|blank workout card|settings)$|library/i;
const allProg = { at: 0, tabs: null, loading: null };
async function loadAllProgramming() {
  if (allProg.tabs && Date.now() - allProg.at < ALL_PROG_TTL) return allProg.tabs;
  if (allProg.loading) return allProg.loading;
  allProg.loading = (async () => {
    const names = (await tabNames(PROGRAMMING)).filter(t => !NOT_PROGRAMMING.test(t.trim()));
    const tabs = await Promise.all(names.map(async tab => {
      try { return { tab, weeks: parseWeeks(await grid(PROGRAMMING, tab)) }; }
      catch (e) { console.error(tab + ':', e.message); return { tab, weeks: [] }; }
    }));
    allProg.tabs = tabs; allProg.at = Date.now();
    return tabs;
  })().finally(() => { allProg.loading = null; });
  return allProg.loading;
}

/** "Week n" the way the sheet counts it: Week 1 is the week holding the 1st. */
function weekOfMonth(d) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const mon = new Date(first); mon.setDate(1 - ((first.getDay() + 6) % 7));
  return Math.floor((d - mon) / (7 * 864e5)) + 1;
}

/**
 * Which workout a date gets, in order of trust:
 *   1. a column whose header carries that exact date ("Thursday 10/29"),
 *   2. this week: whatever is live now (the Ready week, same as always),
 *   3. any other week: that month's tab, Week n counted from the 1st.
 */
async function programmingFor(iso) {
  const d = new Date(iso + 'T12:00:00');
  const day = DAYS[d.getDay()];
  const md = `${d.getMonth() + 1}/${d.getDate()}`;

  let all = [];
  try { all = await loadAllProgramming(); } catch (e) { console.error('all programming:', e.message); }
  for (const t of all) for (const w of t.weeks) {
    if (w.days[day] && w.days[day].md === md) return { tab: t.tab, week: w, source: 'dated', confirmed: true };
  }
  if (sameWeek(iso, gymToday())) {
    const { week, confirmed } = pickWeek(cache.programming);
    return { tab: cache.programming.tab, week, source: 'live', confirmed };
  }
  const t = all.find(x => new RegExp(`^${MONTHS[d.getMonth()]}`, 'i').test(x.tab.trim()));
  if (!t) return { tab: null, week: null, source: 'none', confirmed: false };
  const n = weekOfMonth(d);
  return { tab: t.tab, week: t.weeks.find(w => w.number === n) || null, source: 'calendar', confirmed: false, weekNumber: n };
}

/** The archive of past combo weeks ("Curriculum Index"): each block is headed
 *  "WEEK n | title | date it was archived", so a week was live up to that date. */
const ARCHIVE_TTL = 30 * 60 * 1000;
const archive = { at: 0, weeks: null };
async function loadArchive() {
  if (archive.weeks && Date.now() - archive.at < ARCHIVE_TTL) return archive.weeks;
  const rows = await grid(CURRICULUM, 'Curriculum Index');
  const weeks = [];
  let cur = null, header = null;
  for (const row of rows) {
    const a = cell(row, 0);
    if (/^week\s*\d+/i.test(a)) {
      const until = new Date(cell(row, 2));
      cur = { title: cell(row, 1) || a, until: isNaN(until) ? null : until.toISOString().slice(0, 10), towers: {} };
      weeks.push(cur); header = null; continue;
    }
    if (!cur) continue;
    if (/^tower$/i.test(a)) { header = row.map(v => String(v || '').trim().toLowerCase()); continue; }
    if (!header) continue;
    if (a) cur.last = a;
    const tier = cell(row, 1).toUpperCase();
    if (!cur.last || !/^(BLUE|BLACK)$/.test(tier)) continue;
    const t = cur.towers[cur.last] = cur.towers[cur.last] || { tower: cur.last, BLUE: {}, BLACK: {} };
    DAYS.forEach(dn => {
      const col = header.indexOf(dn.toLowerCase());
      if (col >= 0) t[tier][dn] = cell(row, col).replace(/\\n/g, '\n');
    });
  }
  archive.weeks = weeks.filter(w => w.until).sort((x, y) => x.until.localeCompare(y.until))
    .map(w => ({ ...w, towers: Object.values(w.towers) }));
  archive.at = Date.now();
  return archive.weeks;
}

/** Combos for a date: an archived week if the date is before the current one
 *  started; otherwise the Master Schedule, which stays until it's replaced. */
async function combosFor(iso) {
  let weeks = [];
  try { weeks = await loadArchive(); } catch (e) { console.error('archive:', e.message); }
  const last = weeks.length ? weeks[weeks.length - 1].until : null;
  if (last && iso < last) {
    const w = weeks.find(x => iso < x.until);
    if (w) return { towers: w.towers, title: w.title, source: 'archived' };
  }
  return { towers: cache.curriculum, title: cache.weekTitle,
           source: mondayOf(iso) > mondayOf(gymToday()) ? 'ahead' : 'current' };
}

/* ------------------------------------------------------------------ API */

app.get('/api/day', async (req, res) => {
  try {
    await warm();
    // A date picks the day and the week. Old links that only send ?day= still
    // work: that weekday, this week.
    let iso = ISO.test(req.query.date || '') ? req.query.date : null;
    if (!iso) {
      const today = gymToday();
      iso = today;
      if (DAYS.includes(req.query.day)) {
        const d = new Date(mondayOf(today) + 'T12:00:00');
        d.setDate(d.getDate() + ((DAYS.indexOf(req.query.day) + 6) % 7));
        iso = d.toISOString().slice(0, 10);
      }
    }
    const day = DAYS[new Date(iso + 'T12:00:00').getDay()];
    const prog = cache.programming;
    const [p, c] = await Promise.all([programmingFor(iso), combosFor(iso)]);

    // Weekends are coach-led unless a dated column in the sheet says otherwise.
    const weekend = (day === 'Saturday' || day === 'Sunday') && !(p.source === 'dated');
    const workout = weekend ? null : workoutFor(p.week, day);

    res.json({
      date: iso, day,
      thisWeek: sameWeek(iso, gymToday()),
      weekTitle: c.title,
      combosSource: c.source,
      updatedAt: new Date(cache.at).toISOString(),
      announcements: cache.news || [],
      towers: (c.towers || []).map(t => ({
        tower: t.tower,
        BLUE: tokenize(t.BLUE[day], cache.notation),
        BLACK: tokenize(t.BLACK[day], cache.notation),
      })),
      programming: {
        month: prog.month,
        activeTab: p.tab,
        overridden: p.source === 'live' && !!prog.overrideTab,
        weekLabel: p.week ? p.week.label : (p.weekNumber ? `Week ${p.weekNumber}` : null),
        source: p.source,
        confirmed: p.confirmed, confirmedBy: null,
        saturday: weekend, weekend,
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

/* ------------------------------------------------------- TV screen check */

/**
 * Asks the lobby TV Worker what it will show on a given day. Deliberately not
 * worked out here: this app has its own pickWeek, and a preview that computes
 * its own answer can say "fine" while the TV does something else. Asking the
 * Worker means the preview and the screen can never disagree.
 *
 * Then checks, in plain words, every way the screen has failed so far:
 * no month tab, no week, a day column that went missing, an empty link, a
 * link that couldn't be turned into a viewer, and a design that isn't shared.
 */
const TV_CACHE = new Map();           // day -> { at, body }
const TV_INFLIGHT = new Map();        // day -> promise, so two taps don't run two checks
const TV_FRESH_MS = 5 * 60 * 1000;    // a good result is served as-is for 5 minutes
const TV_BAD_MS = 60 * 1000;          // a bad one is rechecked after a minute, so a fix shows quickly
const TV_TIMEOUT_MS = 30 * 1000;      // the Worker reads the sheet through Apps Script; that can take a while
const SHARE_CACHE = new Map();        // embed base -> { at, public }
const SHARE_TTL_MS = 10 * 60 * 1000;

const fmtMin = m => {
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Weekday name in the gym's time zone, `offset` days from today. */
const gymDay = (offset = 0) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', weekday: 'long',
}).format(new Date(Date.now() + offset * 864e5));

/** Canva sends a private design's viewer to a log-in page. A shared one loads. */
async function canvaIsPublic(embed) {
  const base = String(embed || '').split('#')[0];
  if (!base) return null;
  const hit = SHARE_CACHE.get(base);
  if (hit && Date.now() - hit.at < SHARE_TTL_MS) return hit.public;
  let result = null;   // null = couldn't tell
  try {
    const r = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (/\/login|\/signup/i.test(r.url) || r.status === 401 || r.status === 403 || r.status === 404) result = false;
    else if (r.ok) result = true;
  } catch { /* network hiccup — leave as unknown rather than raise a false alarm */ }
  SHARE_CACHE.set(base, { at: Date.now(), public: result });
  return result;
}

/** The slow part: one full check of one day, straight from the Worker. */
async function checkScreen(day) {
  const q = `?day=${encodeURIComponent(day)}`;
  const links = {
    lobby: `${TV_URL}/tv`,
    test: `${TV_URL}/tv?workout=1&day=${encodeURIComponent(day)}`,
    data: `${TV_URL}/tv-data${q}`,
  };

  let tv;
  try {
    const r = await fetch(`${TV_URL}/tv-data${q}`, { signal: AbortSignal.timeout(TV_TIMEOUT_MS) });
    tv = await r.json();
  } catch (e) {
    return {
      day, ok: false, unreachable: true, links, embed: '', windows: [],
      checks: [{ ok: false, label: 'TV Worker', detail: /abort|timeout/i.test(e.message)
        ? 'The TV took too long to answer (it reads the sheet through Apps Script). Tap Recheck.'
        : 'Could not reach the TV Worker: ' + e.message }],
      checkedAt: new Date().toISOString(),
    };
  }

  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });
  const weekend = tv.tab === 'Weekend';
  const windows = (tv.windows || []).map(w => ({ start: fmtMin(w[0]), end: fmtMin(w[1]) }));

  if (tv.error) {
    add(false, 'Sheet', 'The TV could not read the programming sheet: ' + tv.error);
  } else {
    add(!!tv.tab, 'Tab', tv.tab ? tv.tab : 'No tab for this month in the programming sheet.');
    if (tv.tab && !weekend) {
      add(!!tv.week, 'Week', tv.week || 'No week block found in ' + tv.tab + '.');
    }
    if (tv.tab && (weekend || tv.week)) {
      add(!!tv.link, 'Link', tv.link ||
        (weekend
          ? `No Canva link for ${tv.day} in the Weekend tab.`
          : `No TV Link for ${tv.day} in ${tv.week}. If the cell has a link, the ${tv.day} header in that week's day row has probably been moved or deleted.`));
    }
    if (tv.link) {
      add(!!tv.embed, 'Viewer', tv.embed ? 'Built' + (/#(\d+)/.test(tv.embed) ? ', opens on page ' + tv.embed.match(/#(\d+)/)[1] : '') :
        'The link is there but could not be turned into a viewer. Paste the plain Canva share link, not a smart chip or embed code.');
    }
    if (tv.embed) {
      const pub = await canvaIsPublic(tv.embed);
      add(pub !== false, 'Sharing',
        pub === true ? 'Public' :
        pub === false ? 'The design is not shared. In Canva: Share > Anyone with the link > Can view.' :
        'Could not confirm. Check the preview below.');
    }
    add(windows.length > 0, 'Class times',
      windows.length ? windows.map(w => w.start).join(', ')
        : `No class windows for ${tv.day}, so the workout never takes over the screen.`);
  }

  return {
    day: tv.day || day, tab: tv.tab || null, week: tv.week || null,
    embed: tv.embed || '', windows, links, checks,
    ok: checks.every(c => c.ok),
    checkedAt: new Date().toISOString(),
  };
}

/** Runs a check once even if several people ask at the same moment, and
 *  keeps the result. A timeout isn't kept, so the next ask tries again. */
function runCheck(day) {
  if (TV_INFLIGHT.has(day)) return TV_INFLIGHT.get(day);
  const p = checkScreen(day)
    .then(body => { if (!body.unreachable) TV_CACHE.set(day, { at: Date.now(), body }); return body; })
    .finally(() => TV_INFLIGHT.delete(day));
  TV_INFLIGHT.set(day, p);
  return p;
}

/**
 * Answers from memory whenever it can, so the panel shows up instantly.
 * A result past its age is still shown, and refreshed in the background
 * for the next look. Recheck (?fresh=1) always waits for a real answer.
 */
app.get('/api/screens', async (req, res) => {
  const day = DAYS.includes(req.query.day) ? req.query.day : gymDay();
  const hit = TV_CACHE.get(day);
  if (!req.query.fresh && hit) {
    const age = Date.now() - hit.at;
    if (age > (hit.body.ok ? TV_FRESH_MS : TV_BAD_MS)) runCheck(day).catch(() => {});
    return res.json(hit.body);
  }
  try { res.json(await runCheck(day)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* Keep today and tomorrow checked in the background, so the panel is already
 * answered before anyone opens the app — the two days a coach actually checks. */
async function prefetchScreens() {
  for (const d of [gymDay(0), gymDay(1)]) {
    try { await runCheck(d); } catch { /* next round */ }
  }
}
setTimeout(prefetchScreens, 5000);
setInterval(prefetchScreens, TV_FRESH_MS);

/* ------------------------------------------------ month-tab override ---- */

/** What the picker needs: every candidate month tab, which one the calendar
 *  would pick on its own, and which one (if any) is currently forced. */
app.get('/api/programming/status', async (req, res) => {
  try {
    await warm();
    const prog = cache.programming;
    res.json({
      activeTab: prog.tab,
      autoTab: prog.autoTab,
      overrideTab: prog.overrideTab,
      monthTabs: prog.monthTabs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Body: { email, tab }. Empty/omitted tab clears the override and goes
 *  back to the calendar automatically — same as just waiting it out. */
app.post('/api/programming/override', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!SCHEDULERS.includes(email)) return res.status(403).json({ error: 'Not on the schedulers list.' });

    const tab = String(req.body.tab || '').trim();
    if (tab) {
      const tabs = await tabNames(PROGRAMMING);
      if (!tabs.includes(tab)) return res.status(400).json({ error: 'No tab named ' + tab });
    }
    await writeSetting(ACTIVE_TAB_KEY, tab);

    await warm(true);
    res.json({ ok: true, activeTab: cache.programming.tab, overrideTab: cache.programming.overrideTab });
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
    try { cache.notes = await loadNotes(); } catch { /* the list catches up on the next refresh */ }
    res.json({ ok: true, notes: cache.notes || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/notes', async (_, res) => {
  try { await warm(); res.json({ notes: cache.notes || [] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** Mark a note Done (or reopen it). Schedulers and confirmers only —
 *  they're the ones who act on what coaches flag. */
app.post('/api/notes/status', async (req, res) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!SCHEDULERS.includes(email) && !CONFIRMERS.includes(email))
      return res.status(403).json({ error: 'Only schedulers can close notes.' });
    const row = Number(req.body.row);
    if (!(row > 1)) return res.status(400).json({ error: 'Which note?' });
    const status = req.body.status === 'Open' ? 'Open' : 'Done';
    await updateRange(CURRICULUM, 'Requests', `E${row}:E${row}`, [[status]]);
    cache.notes = await loadNotes();
    res.json({ ok: true, notes: cache.notes });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
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
    canCloseNotes: SCHEDULERS.includes(email) || CONFIRMERS.includes(email),
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
