# Self-hosted MCP auth feasibility

Checked 2026-11-02. Scope: `self_hosted_mcp_auth_handoff.md`. This report is updated as implementation evidence is collected.

## Phase 0 evidence and decisions

| Contract / blocker | Status | Finding |
|---|---|---|
| Combined single-Worker OAuthProvider | tested | 1.2.4 works in workerd; no split Worker/service binding is required. |
| Dynamic canonical issuer/resource | tested locally | Construct provider inside fetch from D1-persisted origin. Use absolute authorize/token/registration URLs and exact resource; reject a request on another origin before SDK dispatch. |
| Canonical origin trust | design decision | Owner must explicitly confirm the HTTPS origin while proving the D1 key. Never persist an origin merely because a public request visited first. Registration ceremony binds this confirmation to the WebAuthn origin/RP ID. |
| D1 transactional claim guard | tested locally | A BEFORE INSERT trigger aborts an invalid/replayed ceremony before a batch mutates owner/passkeys/keys. Concurrent claims produce one owner; a forced later constraint failure rolls back the entire operation. |
| Empty-ID D1 + OAUTH_KV provisioning | tested deployed | Wrangler 4.156.1 created both bindings automatically on isolated `whiteboard-auth-poc-6752381e`. No extra admin KV or DO. |
| CLI migration-before-provision | disproved deployed | `d1 migrations apply DB --remote` failed because the auto-named database did not exist. Deploying first, then migrating succeeded. |
| Browser Deploy Button first-run ordering | unresolved | Docs say provisioning occurs in the button flow, but that is not proof of when a custom deploy script runs. Must test the actual button separately. |
| Consent helpers and signing secrets | confirmed from SDK | begin/approve/deny consent use KV and browser-bound handles. A configured signing secret is only required for optional remembered-consent cookies, which this product does not enable. |
| Epoch-aware refresh rejection | confirmed from SDK; runtime test pending | tokenExchangeCallback sees original grant props and env on code/refresh exchange. Throw SDK OAuthError(invalid_grant) on stale epoch; do not update stale props to the current epoch. |
| Grant enumeration/revocation | confirmed from SDK; runtime test pending | listUserGrants(userId,{cursor}) and revokeGrant(grantId,userId). D1 epoch remains authoritative even if KV deletion has not propagated. |
| Passkey verification on workerd/workers.dev | unresolved | Pin maintained SimpleWebAuthn 14.0.3 and prove with a real browser ceremony, including negative/replay cases. |
| Client interoperability | unresolved | Test Inspector and a real AI client; document untested ChatGPT/Claude/Cursor flows individually. |

Initial local gate: **2/2 integration tests passed** in Miniflare/workerd. Deployed ordering/provisioning transcript: [deployment-gate.json](../results/deployment-gate.json). First failed migration is an intentional negative test, not hidden as a successful deployment.

## Versions

- `@cloudflare/workers-oauth-provider` **1.2.4**, npm integrity `sha512-ayo6Z8DBHdAxwDpplFU8BrEoxoSn6wNo+E7ypTENRHUOc8R89A8/+nZ+a8pMZjjXzF0JXfpYXhw/7qqG+DC18Q==`.
- Official upstream source inspected at `b4cec3173079b42e3df2cb9f16a8ff13653709d0`.
- `@simplewebauthn/server` **14.0.3**; MCP server SDK **2.4.0**; Wrangler **4.156.1**; all application dependencies locked in package-lock.
- Wrangler now brings Miniflare 5; the old flat constructor options fail. Tests use its exported `convertV4MiniflareOptions` adapter rather than pretending the old constructor still works.

## Deployment changes required

Use a standard Wrangler template for the official Deploy Button. The earlier `cf` experiment remains valid as an independent deployment option; the button documentation explicitly reads Wrangler config, so a `cloudflare.config.ts`-only template is not assumed to work.

The deploy script must fail closed. Attempt the migration; if and only if the database is absent on first deployment, provision bindings with a maintenance-only Worker, apply migrations, then deploy the real Worker. A SQL/migration failure must stop deployment rather than reset state or silently continue.

No IdP, Access, GitHub OAuth App, new admin KV, external auth service, or Durable Object is introduced. The required OAuth KV remains because it is the SDK storage contract.

## Price check

The handoff contains no numeric price promise. Auth itself uses one Worker, D1, one OAuth KV namespace and the native rate-limit binding. Workers/D1/KV have Free allocations; this does **not** guarantee an arbitrary deployment stays free. KV Free has 1,000 writes and 1,000 list requests per day; an OAuth login/refresh involves multiple operations. Check actual workerd CPU use and deployed request behavior before promising a Free-plan experience. Whiteboard image storage in R2 is separate from this auth-only PoC.

Current official sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

## Primary architecture references

- [Provider README, including combined mode](https://github.com/cloudflare/workers-oauth-provider)
- [SDK authorization contracts](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md)
- [SDK browser-bound consent](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Deploy Button provisioning and migrations](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [SimpleWebAuthn server verification](https://simplewebauthn.dev/docs/packages/server)
- [Approximate per-location rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

Phase 0 establishes feasibility for incremental implementation. Remaining client/browser/deployment acceptance items above are not marked complete by source review alone.
