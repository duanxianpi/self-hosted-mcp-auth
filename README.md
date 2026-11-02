# Self-hosted MCP Auth

One owner, Passkeys for the Web App, OAuth for Remote MCP. Runs in one Cloudflare Worker with D1 and the OAuth SDK's KV namespace. No Zero Trust, social OAuth App, external identity provider, or developer-operated authentication broker.

A single-owner authentication starter for self-hosted Web + Remote MCP applications. Its two test tools demonstrate shared owner identity and read/write scopes.

Agent Whiteboard integrates authentication directly into its application Worker. This repository is a reusable reference; applications do not depend on a separate authentication deployment or broker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/duanxianpi/self-hosted-mcp-auth)

## Set up your deployment

1. Use the button and select your Cloudflare account and Worker name. Accept the template's `npm run deploy` command. No Worker secrets need to be entered.
2. Open the deployed HTTPS address at `/setup`. In Cloudflare Dashboard, open your Worker's **DB** binding → **Explore Data** → `admin_keys`. Copy `secret_display` from the `bootstrap` row. Console alternative: `SELECT secret_display FROM admin_keys WHERE purpose='bootstrap';`.
3. Enter that key on `/setup`, confirm the permanent deployment address, and register a Passkey. The claim key is consumed; a recovery key is now available only in D1.
4. Add `https://<your-worker>.<your-subdomain>.workers.dev/mcp` to a Remote MCP client using OAuth. Sign in with your Passkey if needed, review the client identity, redirect destination, resource and scopes, then explicitly allow access.

The deployment script provisions missing bindings and applies migrations. If the first migration cannot find an unprovisioned database, it temporarily deploys a maintenance-only Worker returning 503, then migrates and publishes the application. SQL failures stop deployment. Redeploys never reset owner or keys.

**Use a stable address.** Passkeys are bound to the RP ID. A custom domain or Worker rename requires an explicit administrator migration; see [architecture](docs/auth-architecture.md). Do not change addresses casually after setup.

## Recover ownership

Open `/recover`, read the current `recovery` key from the same D1 table, and register a replacement Passkey. A successful recovery removes old Passkeys, rotates the key, increments the authoritative D1 auth epoch, and invalidates old Web sessions and MCP credentials. Failed registration leaves the recovery key usable. [Recovery and emergency runbook](docs/owner-recovery.md)

Cloudflare account/D1 administrators are the root of trust: someone who can read or edit D1 can recover ownership. Losing the Cloudflare account itself is outside this application's recovery mechanism.

## Local validation

Requires Node 24+, npm, and a Chromium-family browser. Tests use a disposable virtual WebAuthn authenticator, not your personal Passkeys or biometrics.

```sh
npm ci
npm run typecheck
npm run build
npx playwright install chromium # Linux / machines without the configured browser
node scripts/run-tests.mjs
```

Set `WHITEBOARD_BROWSER` to a Chromium executable if Microsoft Edge is not installed at the default macOS path. Ordinary local HTTP preview is not a production Passkey origin; the automated tests provide an isolated HTTPS browser origin and workerd. Use `npm run deploy` after `wrangler login` for CLI deployment.

For a **fresh, disposable** deployed auth instance only, the same browser suite can run against `AUTH_TEST_REMOTE_ORIGIN`. It reads test keys through the privileged D1 management API and performs ownership recovery. Never run it against an instance containing real owner data. [Validation matrix](docs/validation.md)

## Runtime and storage

- Single Worker; D1 binding `DB`; KV binding `OAUTH_KV`; native approximate rate-limit binding.
- No extra `ADMIN_KV`, Durable Object, signing secret, or remembered-consent secret.
- Private requests check D1 `auth_epoch` on each request; stale KV grants cannot restore access after recovery.
- Browser sessions and MCP tokens are intentionally different credentials. Signing out of the Web App does not revoke connected applications; use `/settings/connected-apps`.
- Admin keys and tokens are never returned by public APIs or written to build/application logs. D1 intentionally stores admin key plaintext for privileged Dashboard pickup.

## Costs and limits

There is no separate authentication service subscription. Workers, D1 and KV have Free allocations, but staying free depends on CPU and operation counts; Free Workers have a 10 ms CPU limit per invocation and KV has 1,000 writes/day. The Workers Paid plan starts at USD $5/month. Full Whiteboard image storage adds R2 separately. This starter does not promise unlimited or guaranteed-free operation. [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/)

SDKs are pinned in package-lock: Workers OAuth Provider 1.2.4, SimpleWebAuthn 14.0.3 and MCP SDK 2.4.0. [Security assumptions and limitations](docs/security.md)
