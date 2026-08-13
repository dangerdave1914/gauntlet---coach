# Gauntlet Coach

Coach-facing day view for Gauntlet Fitness. Reads the two Google Sheets and
renders the current day on a phone.

## Deploy (DigitalOcean App Platform)

1. Push this folder to a GitHub repo.
2. App Platform -> Create App -> pick the repo. It detects Node and runs `npm start`.
   Choose the Basic plan. Do NOT use a Droplet; you don't want to patch a box.
3. Settings -> App-Level Environment Variables:

   | Key | Value |
   |---|---|
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | the full service-account JSON on one line — mark **Encrypt** |
   | `CURRICULUM_SHEET_ID` | `1wyxgWkMRi69vIZE_Ra3HWoHBouZ8Mo37a1mdkk0-XWs` |
   | `PROGRAMMING_SHEET_ID` | `156YWMbSQCeWdtu4_NY-kxvrueLfGzn3Jsv9FlHVKtu8` |
   | `CONFIRMERS` | `kendallbriannawaldrop@gmail.com,ilvillageois@gmail.com` |

## Service account

Google Cloud Console -> new project -> enable the Google Sheets API ->
Credentials -> Create service account -> Keys -> Add key -> JSON.

Then share **both** sheets with that account's `client_email`:
- curriculum sheet: Viewer is enough
- programming sheet: **Editor** — confirming writes the Status row back

## Auth

There is none yet. Anyone with the URL can read, and the confirm list is
enforced server-side by typed email, which is honest-but-weak. Before this
goes to the whole staff, put Cloudflare Access with Google login in front:
point the domain's DNS at Cloudflare (proxied), origin = the App Platform URL,
then swap the typed email for the `Cf-Access-Authenticated-User-Email` header.

## Known gaps

- Members pane is not built — needs Mariana Tek API access.
- Repair note and shift swap buttons are stubs.
- No notification when a week goes unconfirmed; confirm in person for now.
