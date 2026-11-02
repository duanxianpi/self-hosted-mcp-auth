# Security boundary and limitations

## Trusted administrator

D1 plaintext admin keys are intentional. Cloudflare administrators who can read D1 can recover ownership; those who can modify D1 or redeploy code already control the instance. An infrastructure account compromise is outside the app-layer boundary. No key is sent through a GET URL or returned by a public API.

## Controls

- 256-bit WebCrypto CSPRNG claim/recovery/session/browser-binding values, hashed comparison/storage for ordinary credential checks.
- One owner enforced by SQLite CHECK/PRIMARY KEY constraints and guarded transactional ceremonies.
- Five-minute challenges, single consumption, browser-bound ceremonies and required WebAuthn user verification.
- Seven-day opaque Web sessions with epoch checks. Add-Passkey and grant revocation require a sign-in within five minutes.
- Resource-bound OAuth access tokens, SDK PKCE validation, exact redirect checks, explicit consent, escaped client metadata and per-tool scopes.
- CIMD requires `global_fetch_strictly_public`. DCR is explicitly enabled for older clients; a self-registered name is labelled unverified. Native private-use redirect schemes are not enabled by default.
- No permissive CORS. Web mutations require the canonical Origin; MCP rejects a foreign browser Origin. Server-to-server MCP clients do not need browser CORS permission.
- CSP, no framing, no-store, nosniff and same-origin referrer policy. Consent permits only the SDK-validated redirect origin in form-action. A no-referrer policy was found to remove Origin from a real browser form POST and was changed accordingly.
- Request size bounds on Web auth, OAuth and MCP bodies. Native rate limiting is approximate/per-location, without persistent attacker-triggered account lockouts.
- Errors are generic; sensitive request/SQL/token content is not logged. Observability is off in the template. If enabling logging, review redaction before collecting requests.

## Residual risks / work still requiring evidence

- Quotas and per-location limiting are not strict global abuse protection; public registration/challenge endpoints can consume free-tier operations.
- KV is eventually consistent. D1 epoch/explicit app revocation protects private access; SDK records may remain visible briefly. SDK consent/code replay guarantees are bounded by its documented KV behavior.
- The D1 Connected Apps index provides immediate consent listing and authoritative revocation even when KV listings lag. SDK cleanup is best effort after D1 revocation commits. A local negative test restores pre-recovery KV records and confirms stale access/refresh paths remain rejected.
- D1 is read on private requests; do not switch auth reads to a replica without a demonstrated consistency design.
- The supplied browser tests use virtual authenticators. Physical iPad/iCloud Keychain/Windows Hello and recovery UX need device validation.
- A real custom-domain migration and each named consumer's OAuth onboarding must be recorded independently. Generic HTTP/PKCE success is not proof that every client's UI works.
- The auth starter does not implement Whiteboard canvas persistence or Snapshot consistency. Integrating those services must preserve their existing data contracts.
