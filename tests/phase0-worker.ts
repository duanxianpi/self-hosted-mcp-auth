import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

// Phase-0 gate: the final application replaces this fail-closed feasibility handler.
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    const state = await env.DB.prepare('SELECT * FROM auth_state WHERE id=1').first();
    if (!state?.canonical_origin) return Response.json({ error: 'setup_required' }, { status: 503 });
    if (new URL(request.url).origin !== state.canonical_origin) return new Response('Canonical origin mismatch', { status: 421 });
    const origin = state.canonical_origin;
    const provider = new OAuthProvider({
      apiRoute: origin + '/mcp',
      apiHandler: { fetch: (_r: Request, _e: any, c: any) => Response.json({ props: c.props }) },
      defaultHandler: { fetch: () => new Response('Owner authentication required', { status: 401 }) },
      authorizeEndpoint: origin + '/authorize', tokenEndpoint: origin + '/oauth/token',
      clientRegistrationEndpoint: origin + '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ['mcp:read', 'mcp:write', 'offline_access'],
      requiredScopes: ['mcp:read'],
      resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin] },
    });
    return provider.fetch(request, env, ctx);
  },
};
