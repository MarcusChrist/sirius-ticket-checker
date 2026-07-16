# Sirius Ticket Watch

A tiny Railway cron job that checks for new Sirius ticket signals and sends a push/Slack notification.

It tries two sources:

1. Direct eBiljett events page: `https://siriusfotboll.ebiljett.nu/List/Events`
2. Sirius' own news API + HTML listing (primary in practice), because eBiljett usually returns HTTP 403 from hosted servers.

## Recommended Railway variables

```env
SOURCE_MODE=sirius
EVENTS_URL=https://siriusfotboll.ebiljett.nu/List/Events
SIRIUS_SITE_URL=https://www.siriusfotboll.se
SEARCH_TERMS=biljettsläpp,biljetter,biljett
STATE_FILE=/data/seen-events.json
NTFY_TOPIC=<your-unique-topic>
NOTIFY_ON_FIRST_RUN=false
```

`SOURCE_MODE=sirius` is recommended on Railway. `auto` still tries eBiljett first, but Cloudflare typically blocks it from cloud IPs.

## Recommended notification: ntfy

1. Install the `ntfy` app on your iPhone.
2. Subscribe to a hard-to-guess topic, for example `marcus-sirius-biljetter-9f3a12`.
3. Set `NTFY_TOPIC` to that exact topic in Railway variables.

Without `NTFY_TOPIC` or `SLACK_WEBHOOK_URL`, the job will **refuse to mark new signals as seen** (so nothing is silently swallowed).

## Railway setup

1. Push this folder to a GitHub repo.
2. Create a new Railway service from the repo.
3. Add a **persistent volume mounted at `/data`**. Without this, every cron run looks like a first run and you will never get notified.
4. Add the variables above. `STATE_FILE` must point at the volume (`/data/seen-events.json`).
5. Deploy settings come from `railway.json` (cron every 15 minutes, `node src/index.mjs`, restart policy `NEVER`).
6. Do **not** use `npm start` as the start command. On Railway, npm stays as PID 1 and the container can remain `Active` after the check finishes, which makes the next cron tick fail about 15 minutes later.

Cron expression (also set in `railway.json`):

```cron
*/15 * * * *
```

The process should run, check the sources, save state, and exit with code 0.

## How detection works

- Reads Sirius `news` posts via the WordPress API, ordered by date (not relevance).
- Always also scrapes `/nyheter/` so brand-new posts are not buried under older search hits.
- Diffs against `seenKeys` in the state file and notifies only on new keys.
- After the first successful baseline, empty scrapes no longer reset that baseline.
- If every source fails for several consecutive runs, you get a health alert (throttled to about once per 6 hours).

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

On the first run, the app creates a baseline and does **not** notify you about signals that already exist. Set `NOTIFY_ON_FIRST_RUN=true` if you want it to notify for all currently listed signals.

## Optional Slack

Create a Slack Incoming Webhook and set:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

You can use both Slack and ntfy at the same time.

## If you think a release was missed

Check Railway logs for:

- `First run: creating baseline without notifications`
- `All sources failed`
- `No notification channel configured`
- missing volume / `STATE_FILE` resets between runs
- deployments that go `success` → `failure` every other 15-minute tick (container did not exit; confirm start command is `node src/index.mjs` and restart policy is `NEVER`)

Inspect `/data/seen-events.json` on the volume: `baselineEstablished`, `lastCheckedAt`, and whether the missing article URL is already in `seenKeys`.
