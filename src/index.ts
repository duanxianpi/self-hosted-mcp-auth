import { OAuthProvider, OAuthError, AuthorizationError, CimdFetchError, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assert, body, boundedText, csrf, escape, HttpError, json, now, random, session, setCookie, state, type Env } from './common';
import { ensureBootstrap, options, finish } from './owner';
import { authPage, page } from './pages';

async function authorize(request: Request, env: Env, origin: string) {
  const user = await session(request, env);
  if (request.method === 'GET') {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!user) return Response.redirect(origin + '/login?returnTo=' + encodeURIComponent(new URL(request.url).pathname + new URL(request.url).search), 302);
    const detail = await env.OAUTH_PROVIDER.describeConsent(authRequest);
    const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    const rendered = page('Authorize application', `<p><strong>${escape(detail.clientName)}</strong> requests access to your application.</p><p>${detail.clientDomain ? 'Client domain: <strong>' + escape(detail.clientDomain) + '</strong>' : 'Self-registered client; its name is not verified.'}</p><p>Redirect destination: <strong>${escape(detail.redirectHost)}</strong>${detail.redirectIsLoopback ? ' — an application on your computer. Only continue if you started this connection.' : ''}</p><p>Resource: <code>${escape(origin + '/mcp')}</code></p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}">${detail.scope.map(scope => `<label><input type="checkbox" name="scope" value="${escape(scope)}" checked>${escape(scope)}</label>`).join('')}<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`);
    for (const [key, value] of rendered.headers) consent.headers.set(key, value);
    // Chromium checks OAuth form redirects against form-action as well. Only the SDK-validated
    // redirect origin is added; an arbitrary caller-supplied redirect is never trusted here.
    consent.headers.set('Content-Security-Policy', consent.headers.get('Content-Security-Policy')!.replace("form-action 'self'", "form-action 'self' " + new URL(authRequest.redirectUri).origin));
    return new Response(rendered.body, { headers: consent.headers });
  }
  assert(request.method === 'POST', 405); assert(user, 401, 'Owner sign-in required'); csrf(request, origin);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: form.getAll('scope').map(String) });
  const authorizationId = random();
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: approved.request, userId: '1', metadata: { authorizationId }, scope: approved.request.scope, props: { ownerId: 1, authEpoch: user.auth_epoch, authorizationId } });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}
async function app(request: Request, env: Env) {
  const url = new URL(request.url); const path = url.pathname; const s = await state(env);
  if (path === '/authorize') return authorize(request, env, s.canonical_origin!);
  if (request.method === 'GET' && ['/setup', '/login', '/recover', '/settings/passkeys/add'].includes(path)) {
    if (path === '/setup') await ensureBootstrap(env);
    if (path === '/settings/passkeys/add') assert(await session(request, env), 401, 'Sign in first');
    return authPage(path === '/setup' ? 'bootstrap' : path === '/recover' ? 'recovery' : path === '/login' ? 'login' : 'add', !!s.initialized_at);
  }
  if (path === '/api/status' && request.method === 'GET') return json({ initialized: !!s.initialized_at });
  const match = path.match(/^\/auth\/(bootstrap|recovery|login|add)\/(options|finish)$/);
  if (match) { assert(request.method === 'POST', 405); return match[2] === 'options' ? options(request, env, match[1]) : finish(request, env, match[1]); }
  if (path === '/' || path === '/app') {
    if (!s.initialized_at) return Response.redirect(url.origin + '/setup', 302);
    if (!(await session(request, env))) return Response.redirect(url.origin + '/login', 302);
    return page('Authentication ready', '<p>You are signed in with a Passkey. This is the authentication starter; the product canvas is integrated separately.</p><p>MCP address: <code>' + escape(s.canonical_origin + '/mcp') + '</code></p><p><a href="/settings/passkeys/add">Add another Passkey</a> · <a href="/settings/connected-apps">Connected applications</a></p><form id="logout"><button>Sign out of the Web App</button></form>', "document.querySelector('#logout').addEventListener('submit',async e=>{e.preventDefault();await fetch('/logout',{method:'POST'});location.assign('/login');});");
  }
  const user = await session(request, env);
  if (path.startsWith('/api/') || path === '/logout' || path === '/settings/connected-apps') assert(user, 401, 'Owner session required');
  if (path === '/api/me' && request.method === 'GET') return json({ ownerId: user!.owner_id, authEpoch: user!.auth_epoch });
  if (path === '/logout') {
    assert(request.method === 'POST', 405); csrf(request, s.canonical_origin!);
    await env.DB.prepare('DELETE FROM web_sessions WHERE digest=?').bind(user!.digest).run();
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie('__Host-owner', '', 0) });
  }
  if (path === '/api/grants' && request.method === 'GET') return json(await env.OAUTH_PROVIDER.listUserGrants('1', { cursor: url.searchParams.get('cursor') ?? undefined }));
  if (path === '/api/grants/revoke') {
    assert(request.method === 'POST', 405); csrf(request, s.canonical_origin!); assert(user!.created_at > now() - 300, 401, 'Reauthentication required');
    const data = await body(request); assert(typeof data.grantId === 'string');
    let cursor: string | undefined; let selected: any;
    do { const grants = await env.OAUTH_PROVIDER.listUserGrants('1', { cursor }); selected = grants.items.find(g => g.id === data.grantId); cursor = grants.cursor; } while (!selected && cursor);
    assert(selected, 404, 'Grant not found');
    if (selected.metadata?.authorizationId) await env.DB.prepare('INSERT OR IGNORE INTO oauth_revocations VALUES (?,?)').bind(selected.metadata.authorizationId, now()).run();
    await env.OAUTH_PROVIDER.revokeGrant(selected.id, '1');
    return json({ ok: true });
  }
  if (path === '/settings/connected-apps') return page('Connected applications', '<p>Only applications you explicitly approve can use MCP. Revoking one does not sign you out of the Web App.</p><div id="grants"></div>', `
const container=document.querySelector('#grants');let cursor;
do{const r=await fetch('/api/grants'+(cursor?'?cursor='+encodeURIComponent(cursor):''));const page=await r.json();for(const grant of page.items||[]){const row=document.createElement('p');row.append(document.createTextNode(grant.clientId+' · '+grant.scope.join(', ')+' '));const button=document.createElement('button');button.textContent='Revoke';button.addEventListener('click',async()=>{const r=await fetch('/api/grants/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grantId:grant.id})});if(r.ok)row.remove();else document.querySelector('#status').textContent='Sign in again and retry.';});row.append(button);container.append(row);}cursor=page.cursor;}while(cursor);
`);
  return json({ error: 'Not found' }, 404);
}
async function validGrant(env: Env, props: any) {
  const current = await state(env);
  if (props?.ownerId !== 1 || props?.authEpoch !== current.auth_epoch || !current.initialized_at || typeof props.authorizationId !== 'string') return false;
  return !(await env.DB.prepare('SELECT 1 FROM oauth_revocations WHERE authorization_id=?').bind(props.authorizationId).first());
}
async function mcp(request: Request, env: Env, ctx: any) {
  if (!(await validGrant(env, ctx.props))) return json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${(await state(env)).canonical_origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"` });
  if (!ctx.auth.scope.includes('mcp:read')) return insufficientScope(ctx.auth, ['mcp:read']);
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'self-hosted-mcp-auth', version: '0.1.0' });
    server.registerTool('owner_status', { description: 'Read the authenticated owner identity and the auth-starter test note.', inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => {
      const note = await env.DB.prepare('SELECT value FROM auth_probe_note WHERE id=1').first<{ value: string }>();
      return { content: [{ type: 'text', text: JSON.stringify({ ownerId: ctx.props.ownerId, authEpoch: ctx.props.authEpoch, note: note?.value ?? null }) }] };
    });
    server.registerTool('set_test_note', { description: 'Write an auth-starter test note; requires mcp:write. Demonstrates scope enforcement.', inputSchema: z.object({ text: z.string().max(1000) }), annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ text }) => {
      if (!ctx.auth.scope.includes('mcp:write')) return { isError: true, content: [{ type: 'text', text: 'Missing mcp:write scope' }] };
      const result = await env.DB.prepare('INSERT INTO auth_probe_note (id,value) SELECT 1,? WHERE (SELECT auth_epoch FROM auth_state WHERE id=1)=? ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(text, ctx.props.authEpoch).run();
      assert(result.meta.changes === 1, 401, 'Authorization changed');
      return { content: [{ type: 'text', text: 'Saved test note' }] };
    });
    return server;
  }, { legacy: 'stateless', maxRequestBodySize: 65536 });
  return handler.fetch(request);
}
async function dispatch(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  assert(request.url.length <= 16384, 414, 'URL too long');
  if (env.AUTH_LIMITER && (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/oauth/') || url.pathname === '/authorize')) {
    const limited = await env.AUTH_LIMITER.limit({ key: `${url.hostname}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` });
    if (!limited.success) return json({ error: 'Try again shortly' }, 429, { 'Retry-After': '60' });
  }
  const s = await state(env);
  if (s.canonical_origin) assert(url.origin === s.canonical_origin, 421, 'Canonical origin mismatch; use the original deployment address');
  if (!s.canonical_origin) {
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/oauth/') || url.pathname === '/mcp' || url.pathname === '/authorize') return json({ error: 'setup_required' }, 503);
    return app(request, env);
  }
  if (url.pathname === '/mcp') { const origin = request.headers.get('Origin'); assert(!origin || origin === s.canonical_origin, 403, 'Origin rejected'); }
  const origin = s.canonical_origin;
  if (request.method === 'POST' && (url.pathname.startsWith('/oauth/') || url.pathname === '/authorize')) request = new Request(request, { body: await boundedText(request) });
  const provider = new OAuthProvider<Env>({
    apiRoute: origin + '/mcp', apiHandler: { fetch: mcp }, defaultHandler: { fetch: app },
    authorizeEndpoint: origin + '/authorize', tokenEndpoint: origin + '/oauth/token', clientRegistrationEndpoint: origin + '/oauth/register',
    clientIdMetadataDocumentEnabled: true, scopesSupported: ['mcp:read', 'mcp:write', 'offline_access'], requiredScopes: ['mcp:read'],
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] },
    accessTokenTTL: 300, refreshTokenTTL: 2592000,
    tokenExchangeCallback: async ({ props, env }) => { if (!(await validGrant(env, props))) throw new OAuthError('invalid_grant', { description: 'Owner authorization is no longer valid' }); },
    onError: ({ code, description, status, headers }) => json({ error: code, error_description: description }, status, headers),
  });
  return provider.fetch(request, env, ctx);
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let response: Response;
    try { response = await dispatch(request, env, ctx); }
    catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) response = Response.redirect(error.redirectTo, 302);
      else if (error instanceof HttpError) response = json({ error: error.message }, error.status);
      else if (error instanceof AuthorizationError || error instanceof CimdFetchError) response = json({ error: 'Invalid OAuth request' }, 400);
      else response = json({ error: 'Request could not be completed' }, 500);
    }
    const secured = new Response(response.body, response);
    secured.headers.set('Cache-Control', 'no-store'); secured.headers.set('X-Content-Type-Options', 'nosniff'); secured.headers.set('X-Frame-Options', 'DENY'); secured.headers.set('Referrer-Policy', 'same-origin'); secured.headers.set('Strict-Transport-Security', 'max-age=31536000');
    return secured;
  },
};
