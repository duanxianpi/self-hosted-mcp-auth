# Owner recovery

## Normal, browser-only recovery

1. Open the deployed Worker's `/recover` page.
2. In the Cloudflare Dashboard, open the Worker's DB binding, then the `admin_keys` table. Read `secret_display` for the `recovery` row. The application never displays this key.
3. Enter the key and register a replacement Passkey on your new authenticator/device. If WebAuthn fails or is cancelled, retry with the same key.
4. After success, the old key is invalid. The replacement key is in D1; old Passkeys, Web sessions, access tokens and refresh paths cannot regain private access.

No CLI is needed for this normal path. A first-time setup uses the `bootstrap` row instead; that plaintext is cleared after successful setup.

## Lost/corrupt recovery key: advanced administrator procedure

This requires existing Cloudflare D1 read/write rights. It is not a public HTTP endpoint. Losing the Cloudflare account is outside this procedure.

Generate emergency SQL on a trusted machine:

```sh
node scripts/emergency-recovery.mjs
```

The command creates a CSPRNG key and its SHA-256 digest and writes a mode-0600 `.private/emergency-recovery.sql`. It prints only the file path. The key and SQL must not be committed or pasted into chat or logs.

In the correct D1 Dashboard Console, execute that file's statements in order. They first increment the epoch (fail closed for previous credentials), then delete old Web sessions, then upsert a replacement recovery key. If interrupted, finish the privileged repair; do not expose a public reset route. Open `/recover` and complete normal recovery. The key rotates again after a verified replacement.

The SQL assumes `auth_state` and owner rows are intact and initialized. Restore a known-good backup for broader database corruption; do not run initial migrations or delete the existing owner to simulate recovery. Delete the local emergency file after use.

## Address changes

Use the canonical origin from setup. If it is no longer reachable, follow the administrator domain migration in [architecture](auth-architecture.md) before recovery. A Passkey created for the old RP ID will not authenticate under the new one.
