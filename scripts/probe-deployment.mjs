import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../.private/', import.meta.url), { recursive: true, mode: 0o700 });
await mkdir(new URL('../results/', import.meta.url), { recursive: true });
const configURL = new URL('../.private/remote.json', import.meta.url);
try { await readFile(configURL); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const template = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  template.name = `whiteboard-auth-poc-${randomUUID().slice(0,8)}`;
  template.main = '../src/index.ts';
  template.d1_databases[0].migrations_dir = '../migrations';
  delete template.$schema;
  await writeFile(configURL, JSON.stringify(template, null, 2) + '\n');
}
const report = { started_at: new Date().toISOString(), checks: [] };
async function wrangler(args, expectFailure = false) {
  try {
    const r = await exec('./node_modules/.bin/wrangler', [...args, '--config', '.private/remote.json'], { cwd: root, env: { ...process.env, CI: 'true', WRANGLER_LOG_PATH: '/private/tmp/whiteboard-auth-wrangler.log' }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    assertResult(!expectFailure, 'Unexpected success');
    return r.stdout;
  } catch (error) {
    if (!expectFailure) throw error;
    return `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
}
function assertResult(value, message) { if (!value) throw new Error(message); }
const first = await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], true);
report.checks.push({ name: 'CLI migrations before first provisioning', passed: false, expected_limitation: true, observation: first.replace(/\x1b\[[0-9;]*m/g, '') });
console.log('Confirmed: CLI migration before provisioning fails; deploying fail-closed Worker first.');
const deployed = await wrangler(['deploy', '--experimental-auto-create']);
report.checks.push({ name: 'Auto-provision Worker + D1 + OAUTH_KV with no IDs', passed: true, observation: deployed.replace(/\x1b\[[0-9;]*m/g, '') });
const migrated = await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
report.checks.push({ name: 'Migrations after provisioning', passed: true, observation: migrated.replace(/\x1b\[[0-9;]*m/g, '') });
const config = JSON.parse(await readFile(configURL, 'utf8'));
const url = deployed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
assertResult(url, 'Deployment URL missing');
report.name = config.name; report.url = url;
report.checks.push({ name: 'Uninitialized deployment is fail-closed', passed: (await fetch(url + '/mcp')).status === 503 });
report.finished_at = new Date().toISOString();
await writeFile(new URL('../results/deployment-gate.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ name: config.name, url, checks: report.checks.map(c => ({ name: c.name, passed: c.passed, expected_limitation: c.expected_limitation })) }));
