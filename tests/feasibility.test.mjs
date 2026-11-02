import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
test('D1 singleton guard, concurrent claims, and forced-failure rollback', async () => {
  const { mf, db } = await fixture();
  try {
    await db.prepare("INSERT INTO admin_keys VALUES ('bootstrap','not-a-production-key','digest',1,NULL,0)").run();
    for (const id of ['a','b','c']) await db.prepare("INSERT INTO webauthn_challenges VALUES (?,?,'bootstrap','browser',0,1,'https://auth.example','auth.example',9999999999,NULL)").bind(id,id).run();
    const operation = id => db.prepare("INSERT INTO auth_operations VALUES (?,'bootstrap',?,'browser','digest',0,NULL,NULL,1)").bind(id,id);
    await assert.rejects(db.batch([operation('c'), db.prepare('INSERT INTO owner VALUES (2,1)')]));
    assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_operations').first()).n, 0);
    const claim = id => db.batch([operation(id), db.prepare('INSERT INTO owner VALUES (1,1)'), db.prepare('UPDATE auth_state SET initialized_at=1 WHERE id=1'), db.prepare("UPDATE admin_keys SET consumed_at=1,secret_display=NULL WHERE purpose='bootstrap'")]);
    const results = await Promise.allSettled([claim('a'), claim('b')]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM owner').first()).n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_operations').first()).n, 1);
    assert.equal((await db.prepare("SELECT secret_display FROM admin_keys WHERE purpose='bootstrap'").first()).secret_display, null);
  } finally { await mf.dispose(); }
});
test('single Worker builds SDK metadata from D1 canonical origin and rejects other hosts', async () => {
  const { mf, db } = await fixture();
  try {
    await db.prepare("UPDATE auth_state SET canonical_origin='https://unit-auth.example' WHERE id=1").run();
    const metadata = await (await mf.dispatchFetch('https://unit-auth.example/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.issuer, 'https://unit-auth.example');
    assert.equal(metadata.token_endpoint, 'https://unit-auth.example/oauth/token');
    assert.equal(metadata.client_id_metadata_document_supported, true);
    const denied = await mf.dispatchFetch('https://unit-auth.example/mcp', { method: 'POST' });
    assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /resource_metadata=/);
    assert.equal((await mf.dispatchFetch('https://attacker.example/.well-known/oauth-authorization-server')).status, 421);
  } finally { await mf.dispose(); }
});
