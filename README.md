# SeaChat

A Seanime extension with one public chat room for everyone who installs it. A purple chat icon opens the room in Seanime's tray. The repository includes the extension, a Node.js server, and hosting configuration.

**Status:** prototype v0.1.0. Automated tests pass, but the plugin still needs a live Seanime check. The checked-in manifest points to a local server; the public room is not hosted yet.

## Try locally

Install Node.js 24 or newer, clone this repository, and run:

```sh
npm start
```

Copy `Manifest.json` into the `extensions` folder of your Seanime data directory as `seachat.json` (the filename matches the extension ID). Reload Seanime, enable SeaChat, grant access to the chat domain, and click the purple chat icon. Choose a display name to join.

`Manifest.json` embeds the plugin code and connects to `http://127.0.0.1:8787`. That address reaches a server on the computer running Seanime, so a public server is required to connect people on different computers.

## Host the public room on Render

`render.yaml` prepares a single Node 24 web service with a 1 GB persistent disk, generated admin secret, and health checks. This configuration uses a **paid service and disk**. Review the provider's estimate before creating resources. Nothing is deployed by adding these files to GitHub.

1. Merge the implementation into your default branch.
2. In Render, create a Blueprint connected to `DefnoJae/SeaChat`, using the repository's `render.yaml`. Review the service and disk before deploying.
3. Wait for `/health` to return `{ "ok": true }` at the HTTPS URL assigned to your service.
4. Build the extension with that actual URL:

```sh
node build.mjs https://YOUR-SERVICE.onrender.com
```

5. Commit the regenerated `Manifest.json` and `chat.config.json`. Test it in Seanime and share its raw GitHub URL with users:

```text
https://raw.githubusercontent.com/DefnoJae/SeaChat/main/Manifest.json
```

Everyone installing that manifest connects to the same server. If the URL changes, rebuild the manifest. Use a new extension version when publishing updates. The manifest includes its update URL; do not publish a local build over the public manifest.

Keep `ADMIN_TOKEN` private in Render's environment settings and your private admin client. It is never part of the extension. Use one server instance with the persistent disk; separate SQLite files would create separate rooms.

Render references: [Blueprint fields](https://render.com/docs/blueprint-spec) and [persistent disks](https://render.com/docs/disks).

### Docker or your own server

Set a long random `ADMIN_TOKEN` in your environment or an ignored `.env` file, then run:

```sh
docker compose up --build -d
```

Compose binds port 8787 to localhost and stores SQLite in a named volume. Put an HTTPS reverse proxy in front of it for public access. The image runs as the `node` user; custom bind mounts at `/data` must be writable by UID 1000.

For a direct Node deployment, set `HOST=0.0.0.0`, `PORT` to your service port, `DB_PATH` to a persistent writable file, and `ADMIN_TOKEN` to a long random secret.

## Features

- One shared public room, refreshing every three seconds while open.
- Latest 100 messages displayed; latest 1000 messages retained in SQLite.
- Plain text messages up to 1000 characters, with basic spam limits.
- Message reports and private admin endpoints for deletion and session bans.
- Network permission restricted to the configured chat server domain.

## Prototype limits

Display names are unverified and can be duplicated. Reloading the plugin requires joining again. A ban blocks that session; a person can create another one. No AniList identity verification, presence list, image uploads, or moderation dashboard is included.

Sessions are bearer credentials; only token hashes are stored. User/session records have no automatic expiry yet. Messages and display names are public and visible to the server operator. Reports for expired messages are removed when new messages are posted. Avoid posting private information.

Limits are one message per session per two seconds, 20 messages per source IP per minute, five new sessions per source IP per minute, and 180 general requests per source IP per minute. The server ignores forwarded IP headers. Behind Render or another reverse proxy, these IP limits may apply collectively to the proxy, so this setup is suitable for a small initial test. Add trusted proxy handling and stronger identity/abuse controls before a larger rollout.

## Admin API

Use a private API client with `Authorization: Bearer YOUR_ADMIN_TOKEN`:

| Request | Purpose |
| --- | --- |
| `GET /admin/reports` | List reported messages, author IDs, and report counts. |
| `DELETE /admin/messages/123` | Remove message 123. |
| `POST /admin/ban` with `{ "userId": 123 }` | Ban that session and remove its messages. |

Admin endpoints are disabled when `ADMIN_TOKEN` is unset.

## Development

```sh
npm test
npm run build
```

`plugin.js` is the Seanime source. `build.mjs` embeds it into `Manifest.json` and `dist/seachat.json`; an optional argument sets and saves the server's HTTPS origin in `chat.config.json`. With no argument, the build uses the saved origin (initially localhost).

Tests exercise the real HTTP server for shared history, authentication, validation, spam limits, reports, deletion, bans, and persistence. A mocked Seanime context checks join/send and tray polling lifecycle. CI also checks that the committed manifest matches the source. Live rendering in Seanime and a real hosting deployment remain unverified.

Seanime references: [plugin guide](https://seanime.gitbook.io/seanime-extensions/plugins/write-test-share), [permissions](https://seanime.gitbook.io/seanime-extensions/plugins/permissions), and [official UI types](https://raw.githubusercontent.com/5rahim/seanime/main/internal/extension_repo/goja_plugin_types/plugin.d.ts).
