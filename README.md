# SeaChat

One public chat room for everyone who installs this Seanime extension. A purple chat icon opens the room in Seanime's tray.

**Hosting:** Cloudflare Workers + D1 on the **Workers Free plan**. A free `workers.dev` HTTPS address is included, so you do not need to buy a domain or keep your computer online. The old paid Render blueprint has been removed.

**Status:** deployed at https://seachat.seachat-defnojae.workers.dev. v0.4.0 live checks verified two-session profiles, replies, unread lists, context loading and deleted originals. Tray-side positioning and controls were verified in installed Seanime.

## Install SeaChat

Download `Manifest.json` from this repository, save it as `seachat.json` in Seanime's data directory `extensions` folder, reload Seanime, and enable SeaChat. Grant network permission for `seachat.seachat-defnojae.workers.dev` and the storage permission that remembers your session. Click the purple tray icon and choose a display name. Everyone using this public build joins the same room. Version 0.6.0 uses Seanime's Webview API, available since v3.3.0.

The backend uses Cloudflare Workers and D1 without purchasing a domain or upgrading a subscription. Free-tier quotas apply. See [FREE_HOSTING.md](FREE_HOSTING.md) to deploy your own room.

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

The checked-in manifest connects to the public room. For local testing, run `node build.mjs http://127.0.0.1:8787`, then restore the public build with `node build.mjs https://seachat.seachat-defnojae.workers.dev`.

## Features

- One shared room, refreshing every ten seconds while the tray is open.
- Latest 100 messages displayed; up to 1000 recent messages retained.
- Plain text messages up to 1000 characters, reports, and basic spam controls.
- Private admin endpoints for deleting messages and banning sessions.
- The Cloudflare backend returns a small response when history has not changed, reducing database reads. Deletions also change the room revision, so removed messages disappear on the next poll.
- Network permission restricted to the configured chat domain.
- Compact message composer with an inline send arrow and report flag. Enter sends; Shift+Enter adds a new line.
- Three-dot message menus reveal details or open a report dialog with reason and optional details.
- Profile settings: change your display name, choose from seven name colors or randomize, upload or remove a profile picture.
- Uploaded JPEG, PNG and WebP files are cropped to 96×96 JPEG thumbnails before sharing. Original uploads are limited to 5 MB; stored thumbnails to 24 KB. Initials appear until an image is uploaded.
- Profile changes update names, colors and avatars on earlier visible messages. Your session survives extension reloads through Seanime's plugin storage.
- Version 0.4.0 opens beside the left plugin tray, vertically centered, with responsive width and a standard gear icon.
- Reply using the arrow beside a message's menu. A cancellable preview appears above the composer, and sent replies show a clickable quote.
- Replies to your current session are highlighted. The “You were replied to” notice jumps to the oldest unread reply; “Mark all read” clears remaining notices. Read state survives closing or reloading chat.
- Click quotes or notices to load retained older context, then use “Back to latest” to return. Deleted originals display “Original message unavailable”; removed text is not retained in quotes.

## Free-tier capacity

Cloudflare currently includes 100,000 Worker requests per day, 5 million D1 rows read per day, 100,000 rows written per day, and 5 GB of total D1 storage on the Free plan. Limits are shared with other applications in your account. CPU and per-database limits also apply.

At a ten-second polling interval, one continuously open chat uses about 17,280 requests per day for history and reply notices, before joins, sends, reports and avatar loads. A closed chat now checks activity every 30 seconds while Seanime is running, adding about 2,880 requests per continuously running session per day; no avatars or full history are fetched while closed. Reaching latest adds an acknowledgment refresh. Reading older context adds another request per poll. This means the free setup suits a small community, not unlimited simultaneous users. Quiet polls avoid loading the full history, but active conversations use more database reads. Requests stop succeeding when a quota is reached; this setup does not upgrade your account automatically.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing and Free-plan behavior](https://developers.cloudflare.com/d1/platform/pricing/).

## Prototype limits

Display names are unverified and can be duplicated. A ban blocks a session; a person can create another session. AniList verification, presence, arbitrary file uploads, and a moderation dashboard are not included. Uninstalling the extension clears its saved session; profiles cannot currently be recovered on another computer without that session.

Profiles belong to session IDs, not display names. Editing your current profile changes messages from that session; earlier messages posted from a different session keep their own profiles even when their names look similar. Reply notices also belong to the current session and are checked only while chat is open. Replies outside the 1,000-message retention window cannot be recovered.

Sessions use random bearer credentials; only token hashes are stored on the server. The extension stores its session token locally with Seanime's storage permission; it is never sent to the Webview. User records do not expire automatically yet. Messages, names and profile pictures are public, and the server operator can read messages and reports. Avoid posting private information. Node's local database and Cloudflare D1 are separate stores; local history is not migrated automatically.

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

`plugin.js` contains the Seanime bridge; `chat.html` contains the sandboxed UI. `profile.mjs` validates shared profiles and reports; `messages.mjs` defines shared reply queries and validation. `cloudflare/worker.mjs` and its D1 migrations implement free public hosting. `server.mjs` is the optional local Node alternative. Docker/Compose are included for a server you already own. The Lucide settings icon license is included in `THIRD_PARTY_NOTICES.md` and embedded in the distributed UI.

Authenticated API additions: `POST /messages` accepts optional `replyToId`; history messages contain nullable `reply` metadata. `GET /replies?after=<id>` returns incoming reply IDs and timestamps in ascending order, excluding self-replies. `GET /messages/context/<id>` returns up to 100 surrounding messages or 404 when the target is unavailable. The recipient is derived from the original message on the server.

`build.mjs` embeds the plugin in `Manifest.json` and `dist/seachat.json`. Pass your HTTPS origin to save it in `chat.config.json`; later builds reuse it. The manifest points to this repository for updates. Do not overwrite a public manifest with a local test build.

Tests cover shared history, authentication, profile validation and sharing, report details, moderation, Node persistence, the Webview bridge, manifest generation, and the real local Cloudflare runtime including simultaneous sends, rate limits, revision polling, deletion visibility, and retention. CI validates the Worker bundle and checks for manifest drift. Browser checks also exercise the UI in a sandbox with Seanime's `allow-scripts allow-forms` configuration. The v0.6.0 sandbox checks cover unread navigation and the media picker. Installed Seanime checks confirmed the native tray badge and jump-to-present clearing behavior; provider activation additionally requires a real production key and client-network validation.

References: [Seanime plugin guide](https://seanime.gitbook.io/seanime-extensions/plugins/write-test-share), [permissions](https://seanime.gitbook.io/seanime-extensions/plugins/permissions), and [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

### Editing, deleting and reporting messages

The three-dot menu offers Edit and Delete for messages owned by your current session. Editing updates the shared text and reply previews; deletion requires confirmation and removes the message from the chat for everyone. Replies to removed messages show “Original message unavailable”. An older session with the same display name remains a separate owner.

Reports store the selected message ID, reporter session, timestamp, reason and optional details for moderator review. Repeat reports from the same session for the same message are deduplicated. Reporting does not automatically hide messages, delete messages or ban senders. The authenticated admin API lists reports and permits message deletion or session bans; no moderation inbox, push alert or email alert is currently implemented.

Authenticated `PATCH /messages/<id>` accepts `{text}` and `DELETE /messages/<id>` permanently removes a retained message. Both enforce ownership on the server and apply write rate limits. No edit history is kept.

## v0.6.0 unread messages and media

The tray badge counts retained unread messages from other sessions. Opening chat does not clear it: reaching the latest message does. The read cursor persists per server and session. First-time sessions start at the top of the loaded history without counting old messages as new; returning sessions start at the first retained unread message. The down-arrow button jumps to present. Reply notices remain independent. Closed-chat polling backs off on failures and stops when the extension unloads.

Authenticated `GET /activity?after=<messageId>` returns `latestId`, `unreadCount`, and nullable `oldestUnreadId`. The latest ID is a durable insertion high-water mark, so it does not decrease when messages are deleted. `GET /messages?after=<messageId>` includes the same activity snapshot, including unchanged-revision responses.

GIFs and stickers are implemented but disabled in this public release pending confirmed free KLIPY production access. Configure `media-config.json` with the client app key, `productionFreeConfirmed: true`, and `enabled: true`; set backend `MEDIA_ENABLED=true`, rebuild, and verify actual client requests before activation. Never use the admin token as the media app key. The client app key is visible to users. Ads must be disabled in the KLIPY Partner Panel. The picker uses `content_filter=off`, trending/search, and one removable attachment preview with optional caption/reply.

`POST /messages` accepts optional `attachment`: `{provider:"klipy",kind:"gif"|"sticker",id,title,url,previewUrl,width,height}`. Text or media is required. Delivery URLs are preserved exactly and restricted to HTTPS raster formats on `static.klipy.com`, `static1.klipy.com`, and `static2.klipy.com`. No media bytes are stored, proxied or cached. History/context include optional `attachment` and `caption`; older clients receive descriptive text for attachment-only messages. Editing changes captions, not attachments; deleting removes both. Quoted replies retain no deleted original content. Admin report listings include attachment metadata.

Before enabling publicly: confirm free production terms, ads disabled, provider attribution, and [KLIPY integration requirements](https://docs.klipy.com/integration-requirements.md). Requests and media delivery originate from the user's client. Search results keep provider ordering, and credentials are not sent to KLIPY. In this release no custom uploads, favorites or multiple attachments are supported.
