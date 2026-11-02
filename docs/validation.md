# Validation matrix

Results are recorded by `node scripts/run-tests.mjs` under `results/`. Local suites run in Miniflare/workerd with an Edge virtual WebAuthn authenticator. The remote suite uses actual HTTPS requests to a disposable workers.dev instance and reads administrator keys only through D1 management.

Initial deployed suite on 2026-11-02: 10/10 tests passed on `whiteboard-auth-poc-6752381e`. It covered Passkey claim, explicit consent/denial, PKCE, wrong resource, code replay, tool scopes, cookie/token isolation and recovery invalidation. Expanded tests additionally cover login, expiry/replay, concurrent recovery and Connected Apps. See generated reports for the current revision; do not infer a newer deployed revision from a prior local pass.

## Consumer matrix

| Consumer / environment | Evidence |
|---|---|
| Browser + actual WebAuthn verification, local workerd | Automated virtual-authenticator suite |
| Browser + deployed workers.dev + D1/KV | Initial full suite passed; expanded suite pending recorded repeat |
| OAuth public client via DCR + PKCE | Exercised through browser consent and token endpoint |
| MCP SDK legacy 2025 transport | Tool calls exercised using explicit 2025-06-18 headers |
| MCP 2026-07-28 per-request transport | SDK supports it; explicit acceptance test pending |
| MCP Inspector | Pending independent CLI acceptance |
| Codex real AI client | Pending this implementation's test; prior unrelated Bearer PoC does not count |
| ChatGPT / Claude / Cursor onboarding | Not yet tested for this auth implementation |
| Physical device Passkey enrollment | Not yet tested |
| Deploy to Cloudflare button | Browser acceptance pending |

The synthetic `auth_probe_note` table and two tools exist only to exercise read/write permissions. No production Whiteboard data is used.
