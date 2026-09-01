/**
 * Gauntlet Coach — sheet bridge
 *
 * A standalone Apps Script web app that fronts both sheets, so the DO server
 * never needs a service-account key. The script runs as YOU, which is why it
 * can already see both files.
 *
 * ── Setup ────────────────────────────────────────────────────────────────
 * 1. script.google.com → New project → name it "Gauntlet Bridge".
 * 2. Paste this file in, replacing the default Code.gs.
 * 3. Project Settings (gear) → Script Properties → Add:
 *      SHARED_SECRET = a long random string you invent
 *      NOTIFY_TO     = comma-separated emails to alert on repair/swap requests
 * 4. Deploy → New deployment → type: Web app
 *      Execute as: Me
 *      Who has access: Anyone
 *    "Anyone" means anyone with the URL can send a request, which is why the
 *    shared secret exists. Treat the URL + secret pair like a password.
 * 5. Authorize when prompted. You'll hit an "unverified app" screen — that's
 *    normal for your own script. Advanced → Go to Gauntlet Bridge.
 * 6. Copy the /exec URL. That's APPS_SCRIPT_URL on the DO side.
 *
 * Re-deploy after any edit: Deploy → Manage deployments → pencil icon →
 * Version: New version → Deploy. Editing the code alone does NOT update the
 * live URL, which is the single most common way this bites people.
 *
 * Adding mail triggers a fresh permission prompt the first time. Run
 * notifyTest() from the editor once to get it out of the way.
 */

const SHEETS = {
  curriculum: '1wyxgWkMRi69vIZE_Ra3HWoHBouZ8Mo37a1mdkk0-XWs',
  programming: '156YWMbSQCeWdtu4_NY-kxvrueLfGzn3Jsv9FlHVKtu8',
};

/** Tabs the app writes to. Created on first use so nobody has to set them up. */
const LOGS = {
  Requests:      ['Timestamp', 'Type', 'From', 'Details', 'Status'],
  Announcements: ['Posted', 'By', 'Title', 'Message', 'Expires'],
  Staff:         ['Name', 'Email', 'Phone', 'Joined'],
  Schedule:      ['Day', 'Time', 'Class', 'Coach'],
  Events:        ['Date', 'Time', 'Title', 'Who', 'Location', 'Kind'],
  'Shift Changes': ['Date', 'Time', 'Class', 'From', 'To', 'Type', 'Status', 'Note'],
  // Key/Value pairs for small app settings — currently just which Programming
  // month-tab is "live" when a scheduler wants to override the calendar guess.
  Settings:      ['Key', 'Value'],
};

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ error: 'bad_request' });
  }

  const secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret || body.secret !== secret) return json({ error: 'unauthorized' });

  const id = SHEETS[body.sheet];
  if (!id) return json({ error: 'unknown_sheet' });

  try {
    switch (body.action) {
      case 'tabs':   return json({ tabs: tabs(id) });
      case 'grid':   return json({ values: grid(id, body.tab) });
      case 'update': return json({ ok: update(id, body.tab, body.range, body.values) });
      case 'append': return json({ ok: append(id, body.tab, body.row, body.notify) });
      case 'delete': return json({ ok: deleteRow(id, body.tab, body.rowIndex) });
      default:       return json({ error: 'unknown_action' });
    }
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

/**
 * Health check you can hit in a browser. Reports which build is live, so a
 * stale deployment is visible in one glance instead of being guessed at.
 */
const BUILD = 'build-4';

function doGet() {
  return ContentService.createTextOutput(
    'gauntlet bridge ok — ' + BUILD + ' — actions: tabs, grid, update, append, delete');
}

function tabs(id) {
  return SpreadsheetApp.openById(id).getSheets().map(s => s.getName());
}

/** Display values, so dates and numbers arrive as coaches see them. */
function grid(id, tabName) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  const range = sheet.getDataRange();
  return range.getNumRows() ? range.getDisplayValues() : [];
}

/** Used by the week confirmation write-back. */
function update(id, tabName, a1, values) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  sheet.getRange(a1).setValues(values);
  SpreadsheetApp.flush();
  return true;
}

/**
 * Appends one row, creating the tab with headers if it doesn't exist yet.
 * `notify` is { subject, body } — a request that only lands in a spreadsheet
 * nobody watches is worse than the group text it replaced, because now
 * everyone assumes it's handled.
 */
function append(id, tabName, row, notify) {
  const ss = SpreadsheetApp.openById(id);
  let sheet = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    const headers = LOGS[tabName];
    if (headers) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }

  sheet.appendRow(row);
  SpreadsheetApp.flush();

  if (notify && notify.subject) {
    const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO');
    // Mail failing must not fail the write — the row is the record of truth.
    if (to) {
      try {
        MailApp.sendEmail({ to: to, subject: notify.subject, body: notify.body || '' });
      } catch (err) {
        console.error('notify failed: ' + err);
      }
    }
  }
  return true;
}

/** Removes a row outright. Row 1 is headers and is never deletable. */
function deleteRow(id, tabName, rowIndex) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  const n = Number(rowIndex);
  if (!(n > 1) || n > sheet.getLastRow()) throw new Error('bad row ' + rowIndex);
  sheet.deleteRow(n);
  SpreadsheetApp.flush();
  return true;
}

/** Run once from the editor to clear the mail permission prompt. */
function notifyTest() {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO');
  if (!to) throw new Error('Set NOTIFY_TO in Script Properties first.');
  MailApp.sendEmail({ to: to, subject: 'Gauntlet bridge test', body: 'Notifications are working.' });
  Logger.log('sent to ' + to);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
