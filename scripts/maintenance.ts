export default { fetch() { return Response.json({ error: 'deployment_initializing' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } }); } };
