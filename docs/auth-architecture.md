# Authentication architecture

The Cloudflare infrastructure administrator is the root of trust. The administrator proves control with a 256-bit D1-only claim/recovery key. A public visitor can trigger creation of the first claim key but cannot retrieve it or rotate it. There is one owner and potentially multiple Passkeys.

WebAuthn verifies challenge, browser binding, origin, RP ID, user verification and credential signature using SimpleWebAuthn. Public keys and counters are in D1. Opaque Web session IDs are hashed in D1; cookies are host-only `__Host-` cookies with Secure, HttpOnly and SameSite=Lax. Mutations require exact same-origin requests.

The OAuth Provider SDK owns OAuth code/PKCE/token/discovery/registration/consent protocol state in `OAUTH_KV`. The application supplies owner authentication and an explicit consent page. It does not enable remembered consent, upstream login, token exchange or external bearer tokens. No signing secret is required by this selected mode.

## Canonical origin

The deployment template does not know the final hostname. During claim, an administrator proves the D1 key and explicitly confirms the exact current HTTPS origin. A server-issued browser-bound registration challenge stores that confirmation. The successful transactional claim persists canonical origin and RP ID.

Each subsequent request reads D1 before constructing `OAuthProvider`, supplies absolute canonical endpoint URLs and an exact `/mcp` resource, and rejects another request origin with HTTP 421. Public first visits cannot establish the issuer. Forwarded-Host/Origin headers never choose it. OAuth is unavailable before setup.

## Atomic state changes

`auth_operations` has a BEFORE INSERT guard trigger. Inside a D1 `batch`, it validates current epoch, live challenge, browser digest, purpose, unconsumed admin key and matching generation. Bootstrap additionally requires uninitialized state; login additionally compares the stored credential counter. Challenge IDs are unique across successful operations.

The same batch inserts/replaces Passkeys, consumes the ceremony, rotates keys, changes the epoch and creates the new session. A later constraint failure rolls back the guard and all writes. No application-side check of a zero-row UPDATE is used as the transaction guard.

Recovery increments the D1 epoch and deletes old Web sessions. Token issuance/refresh callbacks reject grants from old epochs. Every MCP call validates epoch again after SDK verification. SDK grant deletion is complementary to this D1 boundary. Connected Apps also stores a D1 authorization revocation marker, so a stale KV token cannot bypass an explicit app-level revocation.

The deployed acceptance suite found that a newly issued grant could be absent from the SDK's KV-backed grant listing. `connected_apps` therefore indexes consent identifiers, client IDs, scopes and epochs in the existing D1 database. It contains no OAuth tokens or protocol secrets. Connected Apps lists this index and commits revocation in D1 before attempting SDK cleanup. Recovery hides previous-epoch authorizations immediately. This change adds no infrastructure dependency.

## Service boundary

`createAuthenticatedWorker(adapter)` invokes `renderApp` and `/api/*` `web` handlers after session verification and Web mutation CSRF checks. `registerTools` receives the OAuth identity, scopes and `requireScope`. Production writes must enforce their required scope and perform revision/epoch checks inside their D1 transaction, as the fixture write does for auth epoch. The default `owner_status` / `set_test_note` tools are acceptance fixtures.

Whiteboard vendors this module into its own source and Worker and supplies its application adapter. The generic repository is a reference template, not a separately deployed authentication dependency. Whiteboard currently protects its existing canvas PoC; its production Snapshot and feedback services remain separate product milestones.

## Domain migration

Keep the original origin when possible. Neither changing a URL nor adding a domain transfers Passkeys to a different RP ID.

For an intentional administrator migration: back up data, pin the existing D1/KV IDs before renaming the Worker (auto-provisioned names otherwise change), attach the new HTTPS domain, update `canonical_origin` and `rp_id` through privileged D1 management, increment `auth_epoch`, redeploy to discard cached SDK helper instances, and follow D1 recovery at the new origin to enroll new Passkeys. Old tokens/sessions must be rejected. The old domain is rejected rather than silently accepted.

Host-mismatch rejection is tested. A real custom-domain/Worker-rename migration is a separate operational acceptance item, not claimed as tested by those checks.
