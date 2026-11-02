# Self-hosted MCP Auth

A GitHub template for building a personal, self-hosted Web App with a private Remote MCP endpoint on Cloudflare. Both interfaces belong to one owner:

- **Web App:** sign in with a Passkey and a secure session cookie.
- **Remote MCP:** connect an AI client through OAuth authorization with explicit consent and read/write scopes.
- **Setup and recovery:** prove ownership with a high-entropy key read from your own Cloudflare D1 database.

Everything runs in one Worker with D1 and the OAuth SDK's KV namespace. No Zero Trust, external identity provider, social OAuth App registration, or developer-operated authentication broker is required. GitHub is used to host and deploy your code, not to authenticate users of the deployed app.

[**Use this template**](https://github.com/duanxianpi/self-hosted-mcp-auth/generate) · [**Fork for upstream updates**](https://github.com/duanxianpi/self-hosted-mcp-auth/fork)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)

The deployment button opens Cloudflare's general **Create an app** page. Select the repository you created from this template or your own fork. The button does not create another repository for you.

This is an authentication starter, not a finished Whiteboard application or a hosted auth service. Its `owner_status` and `set_test_note` tools demonstrate shared identity and scope enforcement. Replace them with your own application handlers. Agent Whiteboard embeds this authentication source directly in its own Worker.

## Create and deploy your project

1. Choose **Use this template → Create a new repository** to start an independent project under your GitHub account; it can be private. If you want GitHub's built-in **Sync fork** for future upstream updates, choose **Fork** instead. These are alternative starting points.
2. Click **Deploy to Cloudflare** above, sign in, and select your Cloudflare account.
3. Choose **Continue with GitHub**, authorize the official Cloudflare integration if needed, and select **your repository** from the list. If it is missing, check that the integration can access it.
4. Keep the Worker name consistent with `name` in `wrangler.jsonc` (initially `self-hosted-mcp-auth`). To use another Worker name, edit that field in your repository before deployment. The GitHub repository itself may have a different name.
5. Select your production branch, normally `main`, with the repository root as the project directory. Use **Build command:** `npm run build` and **Deploy command:** `npm run deploy`, then deploy. You do not need to enter an owner secret or create D1/KV manually.

The deployment script provisions missing bindings and applies migrations. If the first migration cannot find an unprovisioned database, it temporarily deploys a maintenance-only Worker returning 503, then migrates and publishes the application. SQL failures stop deployment. Redeploys never reset owner or keys. [Deployment and compatibility evidence](docs/validation.md)

## Set up your deployment

1. Open the deployed HTTPS address at `/setup`. This creates the claim key in D1 without displaying it on the website.
2. In Cloudflare Dashboard, open your Worker's **DB** binding → **Explore Data** → `admin_keys`. Copy `secret_display` from the `bootstrap` row. Console alternative: `SELECT secret_display FROM admin_keys WHERE purpose='bootstrap';`. Keep this value private.
3. Enter that key on `/setup`, confirm the permanent deployment address, and register a Passkey. The claim key is consumed; a recovery key is now available only in D1. You can now sign in to the Web App at `/app`.
4. Add `https://<your-worker>.<your-subdomain>.workers.dev/mcp` to an OAuth-capable Remote MCP client. Sign in with your Passkey if needed, review the client identity, redirect destination, resource and scopes, then explicitly allow access. The demo's read scope is `mcp:read`; writing a test note additionally requires `mcp:write`. See the [consumer validation matrix](docs/validation.md) for the clients and flows actually tested.

**Use a stable address.** Passkeys are bound to the RP ID. A custom domain or Worker rename requires an explicit administrator migration; see [architecture](docs/auth-architecture.md). Do not change addresses casually after setup.

## Build your application on the template

The exported `createAuthenticatedWorker(adapter)` in `src/index.ts` provides three integration hooks:

| Hook | Purpose |
|---|---|
| `renderApp(request, env, owner)` | Serve your Web App after owner session verification. |
| `web(request, env, owner)` | Handle your `/api/*` routes after session verification and mutation CSRF checks. Return `undefined` for an unhandled route. |
| `registerTools(server, env, owner)` | Register your MCP tools after OAuth and owner-epoch verification. Use `owner.scopes` and `owner.requireScope(...)` to enforce each tool's permissions. |

Create a product entrypoint, import the factory, and pass your hooks. Set `main` in `wrangler.jsonc` to that entrypoint. Web and MCP handlers should call the same application services with the authenticated `ownerId`.

Providing `registerTools` replaces the demo tools. Mutation tools should call `owner.requireScope('mcp:write')` and check `owner.authEpoch` inside the same D1 transaction as their writes. Keep the authentication routes, migrations and credential boundaries intact. [Architecture and integration contract](docs/auth-architecture.md)

## Receive updates

- **Created from this template:** you own an independent project. Upstream changes do not automatically arrive; review and port the changes you need. This starter does not include an automatic updater.
- **Created as a fork:** use GitHub's **Sync fork → Update branch** to bring in upstream commits. Resolve any conflicts before updating the production branch. Cloudflare's connected production branch then triggers a build and deployment.

Preserve your Worker name, D1/KV resource bindings and instance configuration when merging changes. A conflict needs review; syncing upstream is not a reason to replace your database or reset ownership. Database changes should use new migrations. The deployment button is an initial setup entry, not an upgrade action.

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
