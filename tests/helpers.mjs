import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require(require.resolve('miniflare', { paths: [require.resolve('wrangler/package.json')] }));
export const ORIGIN = process.env.AUTH_TEST_REMOTE_ORIGIN ?? 'https://auth.example';
export async function fixture() {
  if (process.env.AUTH_TEST_REMOTE_ORIGIN) {
    const exec = promisify(execFile);
    const db = { prepare(sql) {
      let params = [];
      const statement = { bind(...values) { params = values; return statement; }, async first() { return (await statement.all()).results[0] ?? null; }, async all() {
        let i = 0; const query = sql.replace(/\?/g, () => { const value = params[i++]; return typeof value === 'number' ? String(value) : value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'"; });
        const { stdout } = await exec('./node_modules/.bin/wrangler', ['d1', 'execute', 'DB', '--remote', '--config', '.private/remote.json', '--json', '--command', query], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, WRANGLER_LOG_PATH: '/private/tmp/whiteboard-auth-test-wrangler.log' }, maxBuffer: 1024 * 1024 });
        return JSON.parse(stdout)[0];
      }, async run() { return statement.all(); } };
      return statement;
    } };
    return { db, mf: { remote: true, dispatchFetch: (url, options = {}) => fetch(url, { ...options, redirect: 'manual' }), dispose: async () => {} } };
  }
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: new URL('../dist/worker.js', import.meta.url).pathname, compatibilityDate: '2026-11-02', compatibilityFlags: ['global_fetch_strictly_public', 'nodejs_compat'], d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] }));
  const db = await mf.getD1Database('DB');
  for (const file of ['0001_auth.sql', '0002_probe_and_revocation.sql']) await db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  return { mf, db };
}
export async function browserFixture(mf) {
  const browser = await chromium.launch({ executablePath: process.env.WHITEBOARD_BROWSER ?? (process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : undefined), headless: true });
  const context = await browser.newContext();
  if (!mf.remote) await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const response = await mf.dispatchFetch(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() ?? undefined, redirect: 'manual' });
    const headers = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies.join('\n');
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  await context.route('http://127.0.0.1:8765/callback**', route => route.fulfill({ body: 'Authorization returned' }));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { browser, context, page, cdp, authenticatorId };
}
export async function post(page, path, payload) {
  return page.evaluate(async ({ path, payload }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  }, { path, payload });
}
export async function registerResponse(page, publicKey) {
  return page.evaluate(async publicKey => (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey) })).toJSON(), publicKey);
}
