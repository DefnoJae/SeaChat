# Deploy SeaChat for free

Use **Cloudflare Workers Free + D1**, with Cloudflare's included `workers.dev` HTTPS address. No domain purchase or Render service is needed. Keep Workers on the Free plan; quota exhaustion can make chat unavailable instead of providing unlimited capacity. This guide does not enable a paid plan.

## 1. Get the updated code

After merging the free-hosting pull request, install Node.js 24 or newer and run in PowerShell or a terminal:

```sh
git clone https://github.com/DefnoJae/SeaChat.git
cd SeaChat
npm ci
```

If already cloned, use `git pull` on your main branch instead of cloning again.

## 2. Sign in to Cloudflare

Create a [Cloudflare account](https://dash.cloudflare.com/) if needed. Keep Workers on its Free plan. Then run:

```sh
npx wrangler login
```

Complete sign-in in your browser. Do not send anyone your password, API token, or admin secret.

## 3. Create the shared database

```sh
npx wrangler d1 create seachat
```

Copy the database UUID shown by Wrangler into `database_id` in `wrangler.jsonc`, replacing the all-zero placeholder. Keep the binding as `DB`, database name as `seachat`, and migrations directory as `cloudflare/migrations`. If Wrangler offers to update your configuration automatically, check that this single DB entry and migrations directory are preserved.

The database ID is an identifier, not a password. The rate limit namespace IDs in the same file must be unique in your Cloudflare account; the provided values work if no other binding uses them.

Apply the schema to that shared remote database:

```sh
npm run db:remote
```

Confirm the migration prompt. This creates the chat tables and triggers.

## 4. Deploy the Worker

```sh
npm run worker:deploy
```

Wrangler will print your HTTPS URL, similar to `https://seachat.YOUR-SUBDOMAIN.workers.dev`. If prompted, choose your free `workers.dev` subdomain. No paid domain is required.

Open that URL with `/health` at the end; it should show `{ "ok": true }`. The root URL is an API, not a chat website. Chat opens inside Seanime.

## 5. Set your private admin secret

```sh
npx wrangler secret put ADMIN_TOKEN
```

At the hidden input prompt, paste a long random secret from a password manager and save it privately. Never put it in the extension or GitHub. This enables the private moderation API; chat works without it, but you will not be able to moderate.

## 6. Point everyone at this server

Replace the example below with the **actual** HTTPS URL Wrangler printed:

```sh
node build.mjs https://seachat.YOUR-SUBDOMAIN.workers.dev
```

Commit and push the updated `chat.config.json`, `wrangler.jsonc`, and `Manifest.json` to the repository. The manifest contains only the public server address and plugin code, never your admin secret.

Copy `Manifest.json` to Seanime's `extensions` folder as `seachat.json`, enable it, grant network access to the configured domain, and open the purple chat tray icon. Test from two separate Seanime installations. A live Seanime test is still required before distributing it widely.

Once working, share:

```text
https://raw.githubusercontent.com/DefnoJae/SeaChat/main/Manifest.json
```

Everyone using that manifest joins the same room. Send your public `workers.dev` URL to Codex if you want help rebuilding the manifest; do not share credentials.

## Limits and cost

Stay on Workers Free. Current allowances include 100,000 requests/day and D1's 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage. These allowances are shared across your account. CPU limits and per-database storage limits also apply. A chat left open polls every ten seconds; a small number of continuously active clients can consume the daily allowance.

Quota exhaustion can cause errors until limits reset. This project does not switch your subscription to paid. If your account is already on Workers Paid, usage beyond included amounts can incur charges: confirm your account's plan before deploying.

Official references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/), and [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
