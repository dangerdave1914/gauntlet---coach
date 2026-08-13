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
| `CONFIRMERS` | `kendallbriannawaldrop@gmail.com,ilvillageois@gmail.com` |

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

## Known gaps

- Members pane not built — needs Mariana Tek API access.
- Repair note and shift swap buttons are stubs.
- No notification when a week goes unconfirmed; confirm in person for now.
- Confirming overwrites the Status row, replacing Draft/Coached with
  "Confirmed by …". Say the word and I'll move it to its own row.
