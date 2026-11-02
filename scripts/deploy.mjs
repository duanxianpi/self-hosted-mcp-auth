import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
const extra = process.argv.slice(2);
function run(args) { return spawnSync(cli, [...args, ...extra], { encoding: 'utf8', env: { ...process.env, CI: 'true' } }); }
function show(result) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
let migration = run(['d1', 'migrations', 'apply', 'DB', '--remote']);
if (migration.status !== 0) {
  const output = `${migration.stdout ?? ''}\n${migration.stderr ?? ''}`;
  if (!/Couldn't find an auto-provisioned D1 DB|Couldn't find a D1 DB|database.*not found/i.test(output)) { show(migration); process.exit(migration.status ?? 1); }
  console.log('First deployment: provision resources with a fail-closed maintenance entrypoint.');
  const provision = run(['deploy', fileURLToPath(new URL('./maintenance.ts', import.meta.url)), '--experimental-auto-create']); show(provision); if (provision.status !== 0) process.exit(provision.status ?? 1);
  migration = run(['d1', 'migrations', 'apply', 'DB', '--remote']);
}
show(migration); if (migration.status !== 0) process.exit(migration.status ?? 1);
const deployed = run(['deploy', '--experimental-auto-create']); show(deployed); process.exit(deployed.status ?? 1);
