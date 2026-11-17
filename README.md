# Gauntlet Coach

Coach-facing day view for Gauntlet Fitness. Reads the curriculum and programming
sheets and renders the current day on a phone.

Two pieces:
- **Code.gs** — an Apps Script web app that fronts both sheets. It runs as you,
  so it already has access. No service-account key, no Google Cloud project.
- **server.js** — a Node app on DigitalOcean that calls the bridge, parses the
  sheets, and serves the UI.

## 1. Deploy the bridge

Setup steps are in the header comment of `Code.gs`. The curriculum sheet is
now **Master Control v2** (`1Bp7EJ…`). Short version:
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
| `MT_API_KEY` | Mariana Tek Admin API key, for the Members pane — mark **Encrypt** |
| `MT_SUBDOMAIN` | optional, defaults to `gauntletfitness` |
| `MT_LOCATION` | optional, defaults to `48717` |

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

## Members pane (Mariana Tek)

`mariana.js` reads the day's class sessions and their reservations from the
Mariana Tek Admin API. Read-only: it never books, cancels or checks anyone in.
Each class shows who's booked: blue = checked in, outlined NEW = first visit,
dashed = waitlist, struck through = no-show. It follows the day picker, and
results are cached for 2 minutes (↻ forces a refresh).

Only emails on the Staff tab get rosters, and only first name + last initial
leave the server. That's still typed-email identity, so put Cloudflare Access in
front before relying on it.

### Milestones

The top of the Members pane lists everyone booked in the next 14 days who is
about to hit 25, 50, 100, 200, 300, 400 or 500 classes. When a member is
booked far enough ahead, it names the exact class where they cross the line,
so there's lead time to prep the celebration. Anyone within 5 classes who
isn't booked that far out still shows, marked "to go".

A class count = Mariana Tek's own `completed_class_count` for the member. Two consequences:
history from before Gauntlet moved onto Mariana Tek isn't counted, and anyone
who isn't checked in at the desk doesn't get credit. Roster chips also show
each member's count and their roadmap tier (WHITE under 15, BLUE 15–49, BLACK
50+), and turn gold within 3 of a milestone.

Tune with `MILESTONES`, `MILESTONE_WINDOW_DAYS` and `MILESTONE_LEAD`. The list
rebuilds in the background every 30 minutes.

### Check-in

On today's rosters, tap a booked name → confirm → Mariana Tek marks them
checked in (and they move one class toward their milestone). This is the
app's only write to Mariana Tek. It needs the API key to have check-in
permission; a read-only key gets a plain "doesn't have check-in permission"
message. Only reservations already shown on a loaded roster can be checked in.

### Private lessons

Privates are Mariana Tek **Appointments** (their own schedule, not classes),
under services whose name matches `MT_PRIVATE_MATCH` (default "private" —
Gauntlet's "PRIVATE LESSONS"; "Personal Training" is left out unless the
pattern includes it, e.g. `private|personal`).

Members → Privates shows what's coming up, each client's last and next lesson,
coach, and lessons left in their private pack (from `credit_transactions`),
flagged **Renew** at `PRIVATE_LOW` (2) or fewer. Coaches see their own;
schedulers see all.

**+ Book a private:** pick a client, date, time and (schedulers) coach; the app
creates the appointment booking in Mariana Tek. Coaches can only book
themselves, matched by name between the Staff tab and Mariana Tek. Booking
fields are sent in the same format as the gym's existing bookings, and
Mariana Tek's own error is shown if it refuses. Clients out of lessons can't be
picked; with `MT_PACK_URL` set they get a "Send pack link" button.

First run: after setting `MT_API_KEY`, open
`/api/members/probe?email=<a scheduler's email>`. It returns field **names**
only (no member data), which shows whether the date and class_session filters
took and what Mariana Tek actually calls each field.

## Known gaps

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
