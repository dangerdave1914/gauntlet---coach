# Gauntlet Coach

Coach-facing day view for Gauntlet Fitness. Reads the curriculum and programming
sheets and renders the current day on a phone.

Two pieces:
- **Code.gs** — an Apps Script web app that fronts both sheets. It runs as you,
  so it already has access. No service-account key, no Google Cloud project.
- **server.js** — a Node app on DigitalOcean that calls the bridge, parses the
  sheets, and serves the UI.

## 1. Deploy the bridge

Setup steps are in the header comment of `Code.gs`. Short version:
script.google.com → new project → paste `Code.gs` → Script Properties →
`SHARED_SECRET` = a long random string → Deploy as Web app, **Execute as: Me**,
**Who has access: Anyone** → copy the `/exec` URL.

Sanity check: open that URL in a browser. It should say `gauntlet bridge ok`.
If it shows a Google sign-in page, access isn't set to Anyone.

**After any edit to Code.gs you must redeploy as a new version.** Deploy →
Manage deployments → pencil → Version: New version → Deploy. Editing alone does
not update the live URL. This is the most common way this setup breaks.

## 2. Deploy the app

Push this folder to GitHub, then DigitalOcean → Apps → Create App → pick the
repo. It detects Node and runs `npm start`. Basic plan. No database needed.

App-Level Environment Variables:

| Key | Value |
|---|---|
| `APPS_SCRIPT_URL` | the `/exec` URL from step 1 |
| `APPS_SCRIPT_SECRET` | must match `SHARED_SECRET` — mark **Encrypt** |
| `CONFIRMERS` | who can confirm a week's programming rollout |
| `ANNOUNCERS` | who can post announcements — defaults to `CONFIRMERS` if unset |
| `SCHEDULERS` | who can add class slots and assign coaches — defaults to `CONFIRMERS` |

Script Properties on the Apps Script side also need `NOTIFY_TO` — comma-separated
emails that get alerted when a coach files a note or swap request.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Bridge returned non-JSON` | Deployment isn't "Anyone", or Code.gs was edited without redeploying |
| `Bridge: unauthorized` | `APPS_SCRIPT_SECRET` doesn't match `SHARED_SECRET` |
| `Bridge: no tab named X` | Tab was renamed in the sheet |
| Combos pane empty | Master Schedule tab name no longer matches `/master schedule/i` |
| Workout pane empty | No month tab starting with the current month name |

## Auth

There is none yet. Anyone with the URL can read, and the confirm list is
enforced server-side by typed email — honest but weak. Before this goes to the
whole staff, put Cloudflare Access with Google login in front: point the
domain's DNS at Cloudflare (proxied), origin = the App Platform URL, then swap
the typed email for the `Cf-Access-Authenticated-User-Email` header.

## How scheduling works

`Schedule` is the standing weekly grid — one row per class slot
(Day / Time / Class / Coach). It repeats every week.

`Shift Changes` is a log of dated exceptions. A cover or trade writes a row
here; it never edits the standing grid. So covering one Saturday doesn't
silently become permanent, and the grid stays the thing a scheduler owns.

`Events` holds dated one-offs, with a Kind column:
- **Event** — off-site or special, can have several coaches (Red Bull Slay:
  April coaching, Paul and Mason assisting)
- **Meeting** — admin meeting, staff only
- **Closed** — cancels a standing slot for that date. A time cancels that one
  class; a blank time cancels the whole day.

A slot's coach for a given date = the standing assignment, overridden by any
accepted change matching that date, time and class, and struck through if a
closure covers it.

The Class column is a label, not a requirement. Your paper schedule is mostly
just a time and a name, so leave it blank unless a slot needs distinguishing
(Fire, Kickboxing).

Coaches are matched to shifts by display name, so the Staff tab refuses two
people with the same name — there are two Kendalls, and crossing them would
put one coach's shifts on the other's phone.

Swaps are peer-to-peer — no approval step. Both the request and the acceptance
email `NOTIFY_TO`, so whoever runs the floor still finds out.

## Known gaps

- Members pane not built — needs Mariana Tek API access.
- Coaches identify themselves by typed email at intake. Nothing stops someone
  typing another coach's address, which matters more now that swap
  notifications name people. Cloudflare Access fixes this properly.
- Swap notifications go to `NOTIFY_TO`, not to the individual coach being
  asked — per-person email needs the Staff tab wired into the notify step.
- No notification when a week goes unconfirmed; confirm in person for now.
- Anyone with the URL can read and file a note. Posting and confirming are
  gated by typed email, which is honest but weak until Cloudflare Access is on.
- Confirming overwrites the Status row, replacing Draft/Coached with
  "Confirmed by …". Say the word and I'll move it to its own row.
