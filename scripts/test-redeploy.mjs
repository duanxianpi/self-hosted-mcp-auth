import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const credential = JSON.parse(await readFile(new URL('../.private/client.json', import.meta.url), 'utf8'));
const sql = 'SELECT auth_epoch,initialized_at,canonical_origin,(SELECT group_concat(id) FROM passkeys) AS credentials,(SELECT group_concat(purpose || generation || coalesce(consumed_at,0)) FROM admin_keys) AS key_versions FROM auth_state WHERE id=1';
async function fingerprint() {
  const { stdout } = await exec('./node_modules/.bin/wrangler', ['d1', 'execute', 'DB', '--remote', '--config', '.private/remote.json', '--json', '--command', sql], { maxBuffer: 2 ** 20 });
  return createHash('sha256').update(JSON.stringify(JSON.parse(stdout)[0].results)).digest('hex');
}
async function probe() {
  const response = await fetch(credential.origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + credential.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'owner_status', arguments: {} } }) });
  assert.equal(response.status, 200, 'Existing OAuth token must work across redeployment');
  await response.body.cancel();
}
await probe(); const before = await fingerprint();
const result = await exec(process.execPath, ['scripts/deploy.mjs', '--config', '.private/remote.json'], { timeout: 120000, maxBuffer: 2 ** 20 });
assert(!result.stdout.includes('First deployment:'));
const after = await fingerprint(); assert.equal(after, before); await probe();
const report = { at: new Date().toISOString(), origin: credential.origin, passed: true, owner_passkeys_keys_epoch_preserved: true, existing_oauth_token_preserved: true, migrations_reapplied_without_reset: true };
await writeFile(new URL('../results/redeploy.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
