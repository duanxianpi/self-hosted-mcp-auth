import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { assert, body, cookie, csrf, digest, HttpError, json, now, random, session, setCookie, state, b64, unb64, type Env } from './common';

export async function ensureBootstrap(env: Env) {
  const key = random();
  await env.DB.prepare("INSERT INTO admin_keys (purpose,secret_display,secret_digest,generation,created_at) SELECT 'bootstrap',?,?,1,? WHERE (SELECT initialized_at FROM auth_state WHERE id=1) IS NULL ON CONFLICT(purpose) DO NOTHING").bind(key, await digest(key), now()).run();
}
async function proof(env: Env, purpose: string, key: unknown) {
  assert(typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key), 403, 'Invalid claim or recovery key');
  const hash = await digest(key);
  const record = await env.DB.prepare('SELECT generation FROM admin_keys WHERE purpose=? AND secret_digest=? AND consumed_at IS NULL').bind(purpose, hash).first<{ generation: number }>();
  assert(record, 403, 'Invalid claim or recovery key');
  return { hash, generation: record.generation };
}
function confirmedOrigin(value: unknown, request: Request) {
  assert(typeof value === 'string', 400, 'Confirm canonical HTTPS origin');
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid origin'); }
  assert(url.protocol === 'https:' && url.origin === value && url.origin === new URL(request.url).origin && !url.username && !url.password && !url.port, 400, 'Confirm the exact HTTPS origin shown in your browser');
  return { origin: value, rpID: url.hostname };
}
export async function options(request: Request, env: Env, purpose: string) {
  const s = await state(env); const data = await body(request);
  csrf(request, s.canonical_origin ?? new URL(request.url).origin);
  const headers = new Headers();
  const browser = cookie(request, '__Host-ceremony') || random();
  headers.append('Set-Cookie', setCookie('__Host-ceremony', browser, 600));
  let generation: number | null = null;
  let origin = s.canonical_origin; let rpID = s.rp_id;
  if (purpose === 'bootstrap') {
    assert(!s.initialized_at, 409, 'Already initialized');
    generation = (await proof(env, purpose, data.key)).generation;
    ({ origin, rpID } = confirmedOrigin(data.canonicalOrigin, request));
  } else if (purpose === 'recovery') {
    assert(s.initialized_at, 409, 'Not initialized'); generation = (await proof(env, purpose, data.key)).generation;
  } else if (purpose === 'add') {
    const user = await session(request, env); assert(user && user.created_at > now() - 300, 401, 'Sign in again before adding a Passkey');
  } else assert(purpose === 'login' && s.initialized_at, 409, 'Not initialized');
  assert(origin && rpID);
  const credentials = purpose === 'login' ? [] : (await env.DB.prepare('SELECT id,transports FROM passkeys').all()).results;
  const publicKey = purpose === 'login'
    ? await generateAuthenticationOptions({ rpID, userVerification: 'required' })
    : await generateRegistrationOptions({ rpName: 'Self-hosted MCP App', rpID, userID: new TextEncoder().encode('owner'), userName: 'Owner', attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: credentials.map((c: any) => ({ id: c.id, transports: JSON.parse(c.transports) })) });
  const id = random();
  await env.DB.prepare('INSERT INTO webauthn_challenges (id,challenge,purpose,browser_digest,auth_epoch,key_generation,canonical_origin,rp_id,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, publicKey.challenge, purpose, await digest(browser), s.auth_epoch, generation, origin, rpID, now() + 300).run();
  return json({ id, publicKey }, 200, headers);
}
export async function finish(request: Request, env: Env, purpose: string) {
  const s = await state(env); const data = await body(request);
  csrf(request, s.canonical_origin ?? new URL(request.url).origin);
  assert(typeof data.id === 'string' && data.response?.id);
  const browserDigest = await digest(cookie(request, '__Host-ceremony'));
  const c = await env.DB.prepare('SELECT * FROM webauthn_challenges WHERE id=? AND purpose=? AND browser_digest=? AND consumed_at IS NULL AND expires_at>? AND auth_epoch=?').bind(data.id, purpose, browserDigest, now(), s.auth_epoch).first<any>();
  assert(c, 400, 'Expired or invalid ceremony');
  let keyDigest: string | null = null;
  if (purpose === 'bootstrap' || purpose === 'recovery') keyDigest = (await proof(env, purpose, data.key)).hash;
  if (purpose === 'add') { const user = await session(request, env); assert(user && user.created_at > now() - 300, 401, 'Reauthentication required'); }
  let credential: any; let previousCounter: number | null = null;
  if (purpose === 'login') {
    const saved = await env.DB.prepare('SELECT * FROM passkeys WHERE id=?').bind(data.response.id).first<any>();
    assert(saved, 400, 'Passkey verification failed'); previousCounter = saved.counter;
    const result = await verifyAuthenticationResponse({ response: data.response, expectedChallenge: c.challenge, expectedOrigin: c.canonical_origin, expectedRPID: c.rp_id, credential: { id: saved.id, publicKey: unb64(saved.public_key), counter: saved.counter, transports: JSON.parse(saved.transports) }, requireUserVerification: true });
    assert(result.verified, 400, 'Passkey verification failed');
    credential = { id: saved.id, counter: result.authenticationInfo.newCounter };
  } else {
    const result = await verifyRegistrationResponse({ response: data.response, expectedChallenge: c.challenge, expectedOrigin: c.canonical_origin, expectedRPID: c.rp_id, requireUserVerification: true });
    assert(result.verified && result.registrationInfo, 400, 'Passkey verification failed');
    const info = result.registrationInfo;
    credential = { ...info.credential, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp };
  }
  const t = now(); const token = random(); const tokenDigest = await digest(token);
  const statements = [env.DB.prepare('INSERT INTO auth_operations (id,purpose,challenge_id,browser_digest,key_digest,auth_epoch,credential_id,previous_counter,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(random(), purpose, c.id, browserDigest, keyDigest, c.auth_epoch, credential.id, previousCounter, t)];
  if (purpose === 'bootstrap') statements.push(env.DB.prepare('INSERT INTO owner VALUES (1,?)').bind(t));
  if (purpose === 'recovery') statements.push(env.DB.prepare('DELETE FROM passkeys'));
  if (purpose === 'login') statements.push(env.DB.prepare('UPDATE passkeys SET counter=? WHERE id=?').bind(credential.counter, credential.id));
  else statements.push(env.DB.prepare('INSERT INTO passkeys VALUES (?,1,?,?,?,?,?,?)').bind(credential.id, b64(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), credential.deviceType, credential.backedUp ? 1 : 0, t));
  if (purpose === 'bootstrap') {
    const recovery = random();
    statements.push(env.DB.prepare('UPDATE auth_state SET initialized_at=?,canonical_origin=?,rp_id=? WHERE id=1').bind(t, c.canonical_origin, c.rp_id), env.DB.prepare("UPDATE admin_keys SET secret_display=NULL,consumed_at=? WHERE purpose='bootstrap'").bind(t), env.DB.prepare("INSERT INTO admin_keys VALUES ('recovery',?,?,1,NULL,?)").bind(recovery, await digest(recovery), t));
  }
  if (purpose === 'recovery') {
    const recovery = random();
    statements.push(env.DB.prepare('UPDATE auth_state SET auth_epoch=auth_epoch+1 WHERE id=1'), env.DB.prepare('DELETE FROM web_sessions'), env.DB.prepare("UPDATE admin_keys SET secret_display=?,secret_digest=?,generation=generation+1,created_at=? WHERE purpose='recovery'").bind(recovery, await digest(recovery), t));
  }
  statements.push(env.DB.prepare('UPDATE webauthn_challenges SET consumed_at=? WHERE id=?').bind(t, c.id), env.DB.prepare('INSERT INTO web_sessions SELECT ?,1,auth_epoch,?,? FROM auth_state WHERE id=1').bind(tokenDigest, t + 604800, t));
  // The first statement's DB trigger checks the challenge, key generation and epoch INSIDE this transaction.
  try { await env.DB.batch(statements); }
  catch (error) { if (/invalid_ceremony|invalid_admin_key|already_initialized|credential_changed|UNIQUE constraint/.test(String(error))) throw new HttpError(409, 'Ceremony already used or authorization changed'); throw error; }
  if (purpose === 'recovery' && env.OAUTH_PROVIDER) {
    try {
      let cursor: string | undefined;
      do { const page = await env.OAUTH_PROVIDER.listUserGrants('1', { cursor }); for (const grant of page.items) await env.OAUTH_PROVIDER.revokeGrant(grant.id, '1'); cursor = page.cursor; } while (cursor);
    } catch { console.warn('oauth_grant_cleanup_deferred'); }
  }
  return json({ ok: true }, 200, { 'Set-Cookie': setCookie('__Host-owner', token, 604800) });
}
