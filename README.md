# SeaChat

One public chat room for everyone who installs this Seanime extension. A purple chat icon opens the room in Seanime's tray.

**Hosting:** Cloudflare Workers + D1 on the **Workers Free plan**. A free `workers.dev` HTTPS address is included, so you do not need to buy a domain or keep your computer online. The old paid Render blueprint has been removed.

**Status:** prototype v0.2.0. Automated tests run the Cloudflare backend in its local runtime. Public deployment and rendering inside Seanime still need verification. The checked-in manifest currently connects to localhost.

## What to do now

1. Merge the free-hosting pull request.
2. Create or sign in to a [Cloudflare account](https://dash.cloudflare.com/) and keep Workers on its Free plan.
3. Follow [FREE_HOSTING.md](FREE_HOSTING.md) to deploy the backend.
4. Build the extension with your actual `workers.dev` address, test it in Seanime, and share the manifest with users.

Nothing is deployed or billed merely by merging these files. The setup does not require a paid subscription. Free-tier quotas apply; requests can fail when those limits are reached.

## Try locally

Install Node.js 24 or newer. For the simple Node/SQLite server:

```sh
npm start
```

For the Cloudflare version, which is what you will deploy:

```sh
npm ci
npm run db:local
npm run worker:dev
```

Both local servers use port 8787; run one at a time. Copy `Manifest.json` into Seanime's data directory `extensions` folder as `seachat.json`, reload Seanime, enable SeaChat, and grant its chat domain permission. Click the purple tray icon and choose a display name.

The JSON embeds the plugin source and connects to `http://127.0.0.1:8787` until you build it for your public server. A local address reaches the computer running Seanime, so distribute a public build for people on other computers.

## Features

- One shared room, refreshing every ten seconds while the tray is open.
- Latest 100 messages displayed; up to 1000 recent messages retained.
- Plain text messages up to 1000 characters, reports, and basic spam controls.
- Private admin endpoints for deleting messages and banning sessions.
- The Cloudflare backend returns a small response when history has not changed, reducing database reads. Deletions also change the room revision, so removed messages disappear on the next poll.
- Network permission restricted to the configured chat domain.

## Free-tier capacity

Cloudflare currently includes 100,000 Worker requests per day, 5 million D1 rows read per day, 100,000 rows written per day, and 5 GB of total D1 storage on the Free plan. Limits are shared with other applications in your account. CPU and per-database limits also apply.

At a ten-second polling interval, one continuously open chat uses about 8640 poll requests per day, before joins, sends, and reports. This means the free setup suits a small community, not unlimited simultaneous users. Quiet polls avoid loading the full history, but active conversations use more database reads. Requests stop succeeding when a quota is reached; this setup does not upgrade your account automatically.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing and Free-plan behavior](https://developers.cloudflare.com/d1/platform/pricing/).

## Prototype limits

Display names are unverified and can be duplicated. Reloading the plugin requires joining again. A ban blocks a session; a person can create another session. AniList verification, presence, image uploads, and a moderation dashboard are not included.

Sessions use random bearer credentials; only token hashes are stored. User records do not expire automatically yet. Messages and names are public, and the server operator can read messages and reports. Avoid posting private information. Node's local database and Cloudflare D1 are separate stores; local history is not migrated automatically.

Cloudflare enforces the per-session two-second send cooldown transactionally in D1. Its edge rate limit bindings allow 180 requests/IP/minute, five session creations/IP/minute, 20 sends/IP/minute, and 20 reports/session/minute per Cloudflare location. These edge counters are approximate and local to a location, not a global abuse guarantee. The Worker uses Cloudflare's `CF-Connecting-IP` header. Rate limiter namespace IDs in `wrangler.jsonc` must be unique among rate limit bindings in your account.

The optional Node server keeps its original in-process limits and does not trust forwarded IP headers; behind a proxy its IP limits may apply to the proxy collectively. Add stronger identity controls before a larger rollout.

## Admin API

Use a private API client with `Authorization: Bearer YOUR_ADMIN_TOKEN`:

| Request | Purpose |
| --- | --- |
| `GET /admin/reports` | List reported messages and author IDs. |
| `DELETE /admin/messages/123` | Remove message 123. |
| `POST /admin/ban` with `{ "userId": 123 }` | Ban the session and remove its messages. |

Admin endpoints are disabled when `ADMIN_TOKEN` is unset. Never put this secret in the plugin, manifest, or a tracked file. For local Worker admin tests, use an ignored `.dev.vars` file.

## Development

```sh
npm ci
npm test
npm run worker:check
npm run build
```

`plugin.js` contains the Seanime UI. `cloudflare/worker.mjs` and its D1 migration implement free public hosting. `server.mjs` is the optional local Node alternative. Docker/Compose are included for a server you already own.

`build.mjs` embeds the plugin in `Manifest.json` and `dist/seachat.json`. Pass your HTTPS origin to save it in `chat.config.json`; later builds reuse it. The manifest points to this repository for updates. Do not overwrite a public manifest with a local test build.

Tests cover shared history, authentication, validation, moderation, Node persistence, plugin handlers, manifest generation, and the real local Cloudflare runtime including simultaneous sends, rate limits, revision polling, deletion visibility, and retention. CI validates the Worker bundle and checks for manifest drift. Live Seanime rendering and a remote deployment remain unverified.

References: [Seanime plugin guide](https://seanime.gitbook.io/seanime-extensions/plugins/write-test-share), [permissions](https://seanime.gitbook.io/seanime-extensions/plugins/permissions), and [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
