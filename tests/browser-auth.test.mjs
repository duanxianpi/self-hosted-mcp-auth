import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { fixture, browserFixture, ORIGIN, post, registerResponse } from './helpers.mjs';

test('Passkey bootstrap, OAuth PKCE and D1 recovery work end-to-end with distinct credentials', { timeout: 180000 }, async t => {
  const { mf, db } = await fixture();
  let browserState;
  try { browserState = await browserFixture(mf); } catch (error) { await mf.dispose(); throw error; }
  const { close, context, page, cdp, authenticatorId, callbackUrl } = browserState;
  let replacementAuthenticator;
  const fetchWorker = (path, init) => mf.dispatchFetch(ORIGIN + path, init);
  const rpc = async (access, name, args = {}) => {
    const response = await fetchWorker('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text(); const payload = text.startsWith('event:') ? JSON.parse(text.split('\n').find(x => x.startsWith('data: ')).slice(6)) : JSON.parse(text);
    return { status: response.status, payload };
  };
  const mint = async (scope, decision = 'approve', replay = false) => {
    const registration = await fetchWorker('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: '<unverified test client>', redirect_uris: [callbackUrl], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    assert.equal(registration.status, 201);
    const client = await registration.json(); const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: callbackUrl, response_type: 'code', scope, resource: ORIGIN + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state' });
    await page.goto(ORIGIN + '/authorize?' + query);
    assert.match(await page.locator('main').innerText(), /Self-registered client/);
    assert.equal(await page.locator('main img').count(), 0);
    const submitted = page.waitForResponse(r => new URL(r.url()).pathname === '/authorize' && r.request().method() === 'POST');
    await page.locator(`button[value=${decision}]`).click();
    const consentResponse = await submitted;
    assert.equal(consentResponse.status(), 302, consentResponse.status() === 302 ? '' : await consentResponse.text());
    await page.waitForURL(callbackUrl + '**');
    const redirected = new URL(page.url()); assert.equal(redirected.searchParams.get('state'), 'test-state'); assert.equal(redirected.searchParams.get('iss'), ORIGIN);
    if (decision === 'deny') { assert.equal(redirected.searchParams.get('error'), 'access_denied'); return; }
    const fields = { grant_type: 'authorization_code', client_id: client.client_id, code: redirected.searchParams.get('code'), code_verifier: verifier, redirect_uri: callbackUrl, resource: ORIGIN + '/mcp' };
    const exchange = overrides => fetchWorker('/oauth/token', { method: 'POST', body: new URLSearchParams({ ...fields, ...overrides }) });
    assert.equal((await exchange({ code_verifier: 'wrong-verifier' })).status, 400);
    assert.equal((await exchange({ resource: 'https://wrong.example/mcp' })).status, 400);
    const tokenResponse = await exchange({}); assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    if (replay) assert.equal((await exchange({})).status, 400);
    return { ...tokens, clientId: client.client_id };
  };
  try {
    await t.test('anonymous visits create one D1-only key without leaking it', async () => {
      await Promise.all([fetchWorker('/setup'), fetchWorker('/setup')]);
      const count = await db.prepare("SELECT count(*) AS n FROM admin_keys WHERE purpose='bootstrap'").first(); assert.equal(count.n, 1);
      const key = (await db.prepare("SELECT secret_display FROM admin_keys WHERE purpose='bootstrap'").first()).secret_display;
      for (const path of ['/setup', '/recover', '/api/status']) assert(!(await (await fetchWorker(path)).text()).includes(key));
      assert.equal((await fetchWorker('/api/me')).status, 401);
    });
    await page.goto(ORIGIN + '/setup');
    const key = (await db.prepare("SELECT secret_display FROM admin_keys WHERE purpose='bootstrap'").first()).secret_display;
    await t.test('wrong key, cross-origin and unconfirmed origin fail', async () => {
      assert.equal((await post(page, '/auth/bootstrap/options', { key: randomBytes(32).toString('base64url'), canonicalOrigin: ORIGIN })).status, 403);
      assert.equal((await post(page, '/auth/bootstrap/options', { key, canonicalOrigin: 'https://attacker.example' })).status, 400);
      assert.equal((await fetchWorker('/auth/bootstrap/options', { method: 'POST', headers: { Origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    });
    await t.test('real browser registers a UV Passkey and receives an opaque secure session', async () => {
      await page.locator('#key').fill(key); await page.locator('#confirm').check(); await page.getByRole('button', { name: 'Register Passkey' }).click();
      await page.waitForFunction(() => location.pathname === '/app' || document.querySelector('#status')?.textContent);
      assert.equal(new URL(page.url()).pathname, '/app', await page.locator('#status').innerText());
      assert.equal((await db.prepare('SELECT count(*) AS n FROM owner').first()).n, 1);
      assert.equal((await db.prepare("SELECT secret_display FROM admin_keys WHERE purpose='bootstrap'").first()).secret_display, null);
      const cookies = await context.cookies(); const ownerCookie = cookies.find(c => c.name === '__Host-owner'); assert(ownerCookie?.httpOnly && ownerCookie.secure && ownerCookie.sameSite === 'Lax');
      const me = await page.evaluate(async () => (await fetch('/api/me')).json()); assert.equal(me.ownerId, 1);
      assert.equal((await post(page, '/auth/bootstrap/options', { key, canonicalOrigin: ORIGIN })).status, 409);
    });
    const oldCookie = (await context.cookies()).find(c => c.name === '__Host-owner').value;
    await t.test('explicit denial returns access_denied', () => mint('mcp:read', 'deny'));
    let readTokens, writeTokens;
    await t.test('PKCE, audience and code replay are enforced', async () => { const replayed = await mint('mcp:read', 'approve', true); assert.equal((await rpc(replayed.access_token, 'owner_status')).status, 401); readTokens = await mint('mcp:read offline_access'); writeTokens = await mint('mcp:read mcp:write offline_access'); });
    await t.test('discovery, registered redirects and request size bounds are enforced', async () => {
      const protectedResponse = await fetchWorker('/mcp', { method: 'POST' }); assert.equal(protectedResponse.status, 401); assert.match(protectedResponse.headers.get('www-authenticate'), /resource_metadata=/);
      const metadata = await (await fetchWorker('/.well-known/oauth-protected-resource/mcp')).json(); assert.equal(metadata.resource, ORIGIN + '/mcp');
      const forged = new URLSearchParams({ client_id: readTokens.clientId, redirect_uri: 'https://attacker.example/callback', response_type: 'code', scope: 'mcp:read', resource: ORIGIN + '/mcp', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' });
      const rejection = await fetchWorker('/authorize?' + forged); assert.equal(rejection.status, 400); assert.equal(rejection.headers.get('location'), null);
      assert.equal((await fetchWorker('/oauth/token', { method: 'POST', body: 'x'.repeat(65537) })).status, 413);
    });
    if (!mf.remote) await t.test('expired SDK token records are rejected', async () => {
      const token = await mint('mcp:read'); const [owner, grant] = token.access_token.split(':');
      const kv = await mf.getKVNamespace('OAUTH_KV'); const records = await kv.list({ prefix: `token:${owner}:${grant}:` }); assert.equal(records.keys.length, 1);
      const record = await kv.get(records.keys[0].name, 'json'); record.expiresAt = Math.floor(Date.now() / 1000) - 1;
      await kv.put(records.keys[0].name, JSON.stringify(record));
      assert.equal((await rpc(token.access_token, 'owner_status')).status, 401);
    });
    await t.test('MCP props resolve the same owner; read token cannot write', async () => {
      assert.equal((await rpc(readTokens.access_token, 'owner_status')).status, 200);
      assert.equal((await rpc(readTokens.access_token, 'set_test_note', { text: 'forbidden' })).payload.result.isError, true);
      const write = await rpc(writeTokens.access_token, 'set_test_note', { text: 'test-note' }); assert.equal(write.payload.result.isError, undefined);
      assert.equal((await db.prepare('SELECT value FROM auth_probe_note WHERE id=1').first()).value, 'test-note');
    });
    await t.test('cookie and bearer credentials are not interchangeable', async () => {
      assert.equal((await fetchWorker('/api/me', { headers: { authorization: 'Bearer ' + readTokens.access_token } })).status, 401);
      assert.equal((await fetchWorker('/mcp', { method: 'POST', headers: { cookie: '__Host-owner=' + oldCookie } })).status, 401);
      assert.equal((await fetchWorker('/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + readTokens.access_token, Origin: 'https://attacker.example' } })).status, 403);
    });
    await page.goto(ORIGIN + '/recover');
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    ({ authenticatorId: replacementAuthenticator } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }));
    const recovery = (await db.prepare("SELECT secret_display FROM admin_keys WHERE purpose='recovery'").first()).secret_display;
    let oldKv = [];
    if (!mf.remote) { const kv = await mf.getKVNamespace('OAUTH_KV'); for (const key of (await kv.list()).keys) oldKv.push([key.name, await kv.get(key.name)]); }
    await t.test('recovery GET and failed ceremony leave the recovery key usable', async () => {
      assert(!(await page.content()).includes(recovery));
      const prepared = await post(page, '/auth/recovery/options', { key: recovery }); assert.equal(prepared.status, 200);
      const response = await registerResponse(page, prepared.data.publicKey);
      const broken = structuredClone(response); const clientData = JSON.parse(Buffer.from(broken.response.clientDataJSON, 'base64url')); clientData.origin = 'https://attacker.example'; broken.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString('base64url');
      assert.notEqual((await post(page, '/auth/recovery/finish', { id: prepared.data.id, key: recovery, response: broken })).status, 200);
      assert.equal((await db.prepare("SELECT generation FROM admin_keys WHERE purpose='recovery'").first()).generation, 1);
      const good = await post(page, '/auth/recovery/finish', { id: prepared.data.id, key: recovery, response }); assert.equal(good.status, 200);
      assert((await post(page, '/auth/recovery/finish', { id: prepared.data.id, key: recovery, response })).status >= 400);
    });
    await t.test('recovery rotates key and rejects old sessions, access and refresh paths', async () => {
      // Simulate a stale KV replica returning every pre-recovery protocol record.
      if (!mf.remote) { const kv = await mf.getKVNamespace('OAUTH_KV'); for (const [key, value] of oldKv) await kv.put(key, value); }
      assert.equal((await db.prepare('SELECT auth_epoch FROM auth_state').first()).auth_epoch, 1);
      assert.equal((await db.prepare("SELECT generation FROM admin_keys WHERE purpose='recovery'").first()).generation, 2);
      assert.equal((await fetchWorker('/api/me', { headers: { cookie: '__Host-owner=' + oldCookie } })).status, 401);
      assert.equal((await rpc(readTokens.access_token, 'owner_status')).status, 401);
      assert.equal((await fetchWorker('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: writeTokens.clientId, refresh_token: writeTokens.refresh_token, resource: ORIGIN + '/mcp' }) })).status, 400);
      assert.equal((await post(page, '/auth/recovery/options', { key: recovery })).status, 403);
    });
    await t.test('replacement Passkey logs in; logout revokes the exact cookie', async () => {
      const recoveredCookie = (await context.cookies()).find(c => c.name === '__Host-owner').value;
      assert.equal((await post(page, '/logout', {})).status, 200);
      assert.equal((await fetchWorker('/api/me', { headers: { cookie: '__Host-owner=' + recoveredCookie } })).status, 401);
      await page.goto(ORIGIN + '/login'); await page.getByRole('button', { name: 'Use Passkey' }).click();
      await page.waitForFunction(() => location.pathname === '/app' || document.querySelector('#status')?.textContent);
      assert.equal(new URL(page.url()).pathname, '/app', await page.locator('#status').innerText());
    });
    await t.test('expired, browser-unbound and replayed login challenges fail', async () => {
      const prepared = await post(page, '/auth/login/options', {}); assert.equal(prepared.status, 200);
      const response = await page.evaluate(async publicKey => (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey) })).toJSON(), prepared.data.publicKey);
      const unbound = await fetchWorker('/auth/login/finish', { method: 'POST', headers: { Origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: prepared.data.id, response }) }); assert(unbound.status >= 400);
      assert.equal((await post(page, '/auth/login/finish', { id: prepared.data.id, response })).status, 200);
      assert((await post(page, '/auth/login/finish', { id: prepared.data.id, response })).status >= 400);
      const expired = await post(page, '/auth/login/options', {});
      await db.prepare('UPDATE webauthn_challenges SET expires_at=0 WHERE id=?').bind(expired.data.id).run();
      assert((await post(page, '/auth/login/finish', { id: expired.data.id, response })).status >= 400);
    });
    await t.test('two recovery finalizations commit exactly one replacement and rotation', async () => {
      const currentKey = (await db.prepare("SELECT secret_display FROM admin_keys WHERE purpose='recovery'").first()).secret_display;
      const before = (await db.prepare('SELECT auth_epoch FROM auth_state').first()).auth_epoch;
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: replacementAuthenticator });
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      const first = await post(page, '/auth/recovery/options', { key: currentKey }); const second = await post(page, '/auth/recovery/options', { key: currentKey });
      const response1 = await registerResponse(page, first.data.publicKey); const response2 = await registerResponse(page, second.data.publicKey);
      const result = await Promise.all([post(page, '/auth/recovery/finish', { id: first.data.id, key: currentKey, response: response1 }), post(page, '/auth/recovery/finish', { id: second.data.id, key: currentKey, response: response2 })]);
      assert.equal(result.filter(r => r.status === 200).length, 1);
      assert.equal((await db.prepare('SELECT auth_epoch FROM auth_state').first()).auth_epoch, before + 1);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM passkeys').first()).n, 1);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM owner').first()).n, 1);
    });
    await t.test('Connected Apps revocation blocks token use without ending Web session', async () => {
      const token = await mint('mcp:read mcp:write offline_access');
      await page.goto(ORIGIN + '/app');
      const grants = await page.evaluate(async () => (await fetch('/api/grants')).json());
      const selected = grants.items.find(g => g.clientId === token.clientId); assert(selected);
      assert.equal((await post(page, '/api/grants/revoke', { grantId: selected.id })).status, 200);
      assert.equal((await rpc(token.access_token, 'owner_status')).status, 401);
      assert.equal(await page.evaluate(async () => (await fetch('/api/me')).status), 200);
    });
    if (process.env.AUTH_TEST_EXPORT_CLIENT === '1') {
      const tokens = await mint('mcp:read mcp:write offline_access');
      await mkdir(new URL('../.private/', import.meta.url), { recursive: true, mode: 0o700 });
      await writeFile(new URL('../.private/client.json', import.meta.url), JSON.stringify({ origin: ORIGIN, ...tokens }), { mode: 0o600 });
      await context.storageState({ path: new URL('../.private/browser-state.json', import.meta.url).pathname });
      await chmod(new URL('../.private/browser-state.json', import.meta.url), 0o600);
    }
  } finally { await close(); await mf.dispose(); }
});
