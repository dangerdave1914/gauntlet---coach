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
 *    Generate one on your phone or run: openssl rand -hex 24
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
 */

const SHEETS = {
  curriculum: '1wyxgWkMRi69vIZE_Ra3HWoHBouZ8Mo37a1mdkk0-XWs',
  programming: '156YWMbSQCeWdtu4_NY-kxvrueLfGzn3Jsv9FlHVKtu8',
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
      default:       return json({ error: 'unknown_action' });
    }
  } catch (err) {
    return json({ error: String(err && err.message || err) });
  }
}

/** Health check you can hit in a browser. Deliberately reveals nothing. */
function doGet() {
  return ContentService.createTextOutput('gauntlet bridge ok');
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

/** Used only by the week confirmation write-back. */
function update(id, tabName, a1, values) {
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('no tab named ' + tabName);
  sheet.getRange(a1).setValues(values);
  SpreadsheetApp.flush();
  return true;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function testAccess() {
  Logger.log('curriculum: ' + tabs(SHEETS.curriculum).join(' | '));
  Logger.log('programming: ' + tabs(SHEETS.programming).join(' | '));
}
