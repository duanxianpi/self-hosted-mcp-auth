import { webcrypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toString('base64url');
const sql = `-- PRIVILEGED repair for an existing initialized deployment only. Execute in order.\nUPDATE auth_state SET auth_epoch=auth_epoch+1 WHERE id=1 AND initialized_at IS NOT NULL;\nDELETE FROM web_sessions;\nINSERT INTO admin_keys (purpose,secret_display,secret_digest,generation,consumed_at,created_at) SELECT 'recovery','${key}','${hash}',1,NULL,unixepoch() WHERE EXISTS (SELECT 1 FROM auth_state WHERE id=1 AND initialized_at IS NOT NULL) ON CONFLICT(purpose) DO UPDATE SET secret_display=excluded.secret_display,secret_digest=excluded.secret_digest,generation=admin_keys.generation+1,consumed_at=NULL,created_at=excluded.created_at;\n`;
await mkdir(new URL('../.private/', import.meta.url), { recursive: true, mode: 0o700 });
await writeFile(new URL('../.private/emergency-recovery.sql', import.meta.url), sql, { mode: 0o600, flag: 'wx' });
console.log('Saved .private/emergency-recovery.sql. Read it locally and execute only in the intended D1 administrator Console.');
