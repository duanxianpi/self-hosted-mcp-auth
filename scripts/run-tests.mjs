import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const remote = Boolean(process.env.AUTH_TEST_REMOTE_ORIGIN);
const files = remote ? ['tests/browser-auth.test.mjs'] : ['tests/feasibility.test.mjs', 'tests/browser-auth.test.mjs'];
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], { stdio: ['ignore','pipe','pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
const code = await new Promise(resolve => child.on('exit', resolve));
await mkdir(new URL('../results/', import.meta.url), { recursive: true });
const name = remote ? 'remote-tests' : 'local-tests';
await writeFile(new URL(`../results/${name}.tap`, import.meta.url), stdout + stderr);
const report = { at: new Date().toISOString(), environment: remote ? process.env.AUTH_TEST_REMOTE_ORIGIN : 'Miniflare/workerd + Edge virtual WebAuthn', exit_code: code, passed: code === 0, tests: Number(stdout.match(/# tests (\d+)/)?.[1]), pass: Number(stdout.match(/# pass (\d+)/)?.[1]), fail: Number(stdout.match(/# fail (\d+)/)?.[1]) };
await writeFile(new URL(`../results/${name}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report)); if (code !== 0) { console.error(stdout + stderr); process.exitCode = 1; }
