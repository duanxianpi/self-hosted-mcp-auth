# Self-hosted MCP auth feasibility

Verified 2026-11-02 against `self_hosted_mcp_auth_handoff.md`, current primary documentation, pinned SDK source and working deployments. The core architecture is feasible and implemented. Physical-device and individual consumer onboarding remain explicit compatibility follow-ups.

| Blocker / contract | Result |
|---|---|
| Single Worker OAuthProvider + Passkey Web App | Tested locally and on workers.dev; no split service required |
| Unknown deployment URL | Owner proves D1 key and confirms exact HTTPS origin during WebAuthn enrollment; D1 locks issuer, RP ID and resource. Provider is constructed per request with absolute canonical URLs; another origin returns 421 |
| Atomic claim/recovery | D1 batch plus a SQL guard trigger; concurrent claims and forced-failure rollback passed |
| D1/KV auto-provisioning | CLI and actual Deploy Button passed; no extra admin KV or Durable Object |
| First CLI migration before resource creation | Disproved: absent auto-provisioned DB cannot be migrated. Script deploys a maintenance-only Worker, migrates, then publishes real code |
| Deploy Button migration ordering | Actual button created D1/KV before custom deploy; both initial migrations applied and publish succeeded. Later Git build applied migration 0003 |
| Extra signing/owner secrets | None required in selected SDK mode; optional remembered consent disabled |
| Passkey verification | Real browser ceremonies verified by SimpleWebAuthn in local workerd and deployed Workers; virtual UV authenticator |
| Recovery revocation | Old sessions/access/refresh rejected; local stale-KV restore still rejected by D1 epoch |
| Connected Apps | Runtime exposed delayed KV listings. Added an immediate consent index and revocation marker in existing D1; SDK grant cleanup remains complementary |
| CIMD + DCR | DCR/PKCE exercised end-to-end. Deployed SDK resolved Claude's actual public CIMD and checked its published redirect |
| Independent MCP consumers | Inspector and real Codex read/write/read passed using browser-consented OAuth credentials; modern 2026 and legacy 2025 requests passed |
| Owner and grants across redeploy | Fingerprinted owner/Passkey/key state unchanged; pre-existing OAuth token continued to work |
| Whiteboard integration | Auth source embedded in Whiteboard's own Worker; protected original canvas asset and owner identity adapter passed integration test |

Evidence: [button](../results/deploy-button.json), [local 18/18](../results/local-tests.json), [deployed 15/15](../results/remote-tests.json), [clients](../results/clients.json), [redeploy](../results/redeploy.json). Earlier intentional provisioning failure: [phase-0 transcript](../results/deployment-gate.json). Full boundaries: [validation matrix](validation.md).

## Verified versions and design changes

Workers OAuth Provider **1.2.4**, upstream source `b4cec3173079b42e3df2cb9f16a8ff13653709d0`; npm integrity `sha512-ayo6Z8DBHdAxwDpplFU8BrEoxoSn6wNo+E7ypTENRHUOc8R89A8/+nZ+a8pMZjjXzF0JXfpYXhw/7qqG+DC18Q==`. SimpleWebAuthn **14.0.3**, MCP server SDK **2.4.0**, Wrangler **4.156.1**, Inspector **2.13.0**. Application dependencies are locked.

Use the standard Wrangler template read by Deploy Button, rather than assuming a cf-only deployment config works with it. Miniflare 5 changed constructor options; tests use its exported compatibility adapter. Modern MCP requests need the routing headers and per-request envelope from the current SDK, not only a version header.

The public generic repository is `duanxianpi/self-hosted-mcp-auth`. Whiteboard vendors the source and supplies `createAuthenticatedWorker(adapter)` hooks. It has no runtime dependency on a separate auth deployment. Existing handwriting/export behavior is preserved; Whiteboard's full Snapshot and feedback service implementation is a separate product milestone.

## One-click deployment finding

The official button successfully created a private Git copy, D1 and OAuth KV, ran `npm run build` and `npm run deploy`, and published workers.dev without entering Worker secrets or configuring Access/an upstream OAuth App. An expired pre-existing Cloudflare GitHub authorization initially blocked repository creation; the user refreshed the existing integration and the same template succeeded. A first-time user still needs Cloudflare account and Git integration authorization; the button does not remove platform login steps.

The actual Dashboard Worker → DB → Console path was verified with a read-only query of admin-key availability, without displaying the key in evidence. See the recovery runbook for exact key-pickup SQL. Redeployments apply pending migrations and never reset owner or keys.

## Price check

The handoff contains no numeric price promise. This auth architecture needs one Worker, D1, SDK OAuth KV and the native approximate rate-limit binding. It has no separate auth-service subscription. Free allocations exist, but this is not a guarantee of zero cost: Workers Free has a 10 ms CPU limit per invocation, and KV Free allows 1,000 writes and 1,000 list operations/day. OAuth operations perform multiple storage requests; cryptographic CPU must be measured before promising Free-plan capacity. Workers Paid starts at USD $5/month. Full Whiteboard R2 image storage is separate.

[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

## Primary references

- [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider), [authorization contracts](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md), [consent helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Deploy Button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Dashboard access](https://developers.cloudflare.com/d1/get-started/)
- [SimpleWebAuthn verification](https://simplewebauthn.dev/docs/packages/server)
- [Per-location approximate rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
