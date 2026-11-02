# Validation matrix

Checked 2026-11-02. Tests use disposable virtual WebAuthn authenticators, not personal credentials or biometrics. Generated reports are in `results/`.

| Environment / contract | Evidence |
|---|---|
| Local Miniflare/workerd + browser | 18/18 passed, `results/local-tests.json` and TAP |
| Linux Chromium CI | [Passing acceptance run](https://github.com/duanxianpi/self-hosted-mcp-auth/actions/runs/41504241887); 18 tests on commit 43b4076 |
| Actual Deploy Button | Resource creation, schema migrations and application publish passed; `results/deploy-button.json` |
| Button-created Worker + real HTTPS + D1/KV | 15/15 passed, `results/remote-tests.json` and TAP |
| Redeploy without resetting owner/keys/grants | Passed; `results/redeploy.json` |
| Public DCR + browser consent + PKCE | Passed, including deny, wrong verifier/resource, code replay and forged redirect |
| MCP 2025 transport | Authenticated tools exercised with explicit 2025-06-18 headers |
| MCP 2026-07-28 transport | `server/discover`, `tools/list`, `tools/call` passed with per-request metadata and required routing headers; `results/clients.json` |
| Inspector 2.13.0 | `tools/list` and `owner_status` passed using a browser-consented OAuth access token |
| Real Codex AI client | Read → write → read passed; independent readback confirmed; `results/clients.json`, `results/codex-events.jsonl` |
| Claude CIMD | Deployed SDK resolved Claude's published metadata and validated its callback; redirected to owner login |
| ChatGPT / Claude / Cursor complete OAuth onboarding | Not tested; metadata resolution and token consumption do not prove each consumer's UI flow |
| Physical iPad / Keychain / Windows Hello | Not tested; virtual authenticator evidence only |
| Actual custom-domain migration | Runbook provided; host mismatch tested, operational migration not performed |

The 18 local tests comprise a browser parent test, 15 browser subtests and two workerd/D1 gates. The deployed suite omits the local-only token-record expiry manipulation and D1 gate fixtures. Token expiry is forced in a valid local SDK token record, rather than waiting five minutes. Recovery tests restore pre-recovery KV records locally to prove D1 epoch rejection independently of successful SDK cleanup.

The deployed revocation test initially failed because a fresh KV grant was missing from `listUserGrants`. The application now indexes consent identifiers in D1, commits revocation there first and treats SDK cleanup as complementary. The repeated deployed suite passed after this change.

Linux Chromium initially bypassed interception of loopback redirects and reached a missing listener. Tests now run a real loopback HTTP listener on an OS-assigned port. This both fixes the test harness and exercises a desktop OAuth client's redirect path. No browser security feature was disabled.

Inspector and Codex consume credentials obtained by the tested browser OAuth flow; their own automatic browser-login onboarding was not exercised. This is a shared-owner Web + MCP demo with separate credential paths, not a claim that every client's OAuth UI is supported.

For a **fresh disposable instance only**, write `.private/remote.json` with its resource bindings, then run:

```sh
AUTH_TEST_REMOTE_ORIGIN=https://your-test.workers.dev AUTH_TEST_EXPORT_CLIENT=1 node scripts/run-tests.mjs
node scripts/test-redeploy.mjs
INSPECTOR_CLI=/absolute/path/to/inspector/clients/launcher/build/index.js node scripts/test-clients.mjs
```

The remote suite performs owner bootstrap and recovery. Never use it on an instance holding real data. Exported test credentials and browser state stay mode-0600 under ignored `.private/`. The synthetic note table and tools are acceptance fixtures; Whiteboard does not expose the note tools.

The two earlier disposable auth PoCs were cleaned up after validation. The button-created `mcp-auth-button-test` and its private Git copy are retained for inspection. Its owner uses a disposable virtual Passkey; a human owner must use the documented D1 recovery path before treating it as their own instance. See `results/cleanup.json`.
