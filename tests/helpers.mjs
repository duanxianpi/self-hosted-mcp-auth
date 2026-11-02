import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
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
  try { for (const file of ['0001_auth.sql', '0002_probe_and_revocation.sql', '0003_connected_apps.sql']) await db.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); }
  catch (error) { await mf.dispose(); throw error; }
  return { mf, db };
}
export async function browserFixture(mf) {
  // A real loopback listener exercises the same redirect path as a desktop OAuth client.
  // Chromium on Linux can follow a redirect without re-entering route interception.
  const callbackServer = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Authorization returned'); });
  await new Promise((resolve, reject) => { callbackServer.once('error', reject); callbackServer.listen(0, '127.0.0.1', resolve); });
  const callbackUrl = `http://127.0.0.1:${callbackServer.address().port}/callback`;
  callbackServer.unref();
  const browser = await chromium.launch({ executablePath: process.env.WHITEBOARD_BROWSER ?? (process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : undefined), headless: true });
  const context = await browser.newContext();
  if (!mf.remote) await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const response = await mf.dispatchFetch(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() ?? undefined, redirect: 'manual' });
    const headers = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies.join('\n');
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage();
  // Report only the error class, never a callback URL (which can contain a code).
  page.on('requestfailed', request => console.error('Browser request failed:', request.failure()?.errorText));
  page.on('console', message => {
    if (message.type() === 'error') console.error('Browser console:', message.text().replace(/https?:\/\/[^\s"'<>]+/g, '[URL omitted]'));
  });
  page.setDefaultTimeout(7000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { browser, context, page, cdp, authenticatorId, callbackUrl, async close() { await browser.close(); callbackServer.closeAllConnections(); await new Promise(resolve => callbackServer.close(resolve)); } };
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
