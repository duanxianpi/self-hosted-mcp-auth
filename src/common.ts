import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  AUTH_LIMITER?: RateLimit;
}
export interface State { initialized_at: number | null; auth_epoch: number; canonical_origin: string | null; rp_id: string | null }
export const now = () => Math.floor(Date.now() / 1000);
export const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value: string) => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
export const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers });
export const cookie = (request: Request, name: string) => request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) ?? '';
export const setCookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
export async function state(env: Env): Promise<State> { return (await env.DB.prepare('SELECT initialized_at,auth_epoch,canonical_origin,rp_id FROM auth_state WHERE id=1').first<State>())!; }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function assert(value: unknown, status = 400, message = 'Request rejected'): asserts value { if (!value) throw new HttpError(status, message); }
export async function boundedText(request: Request): Promise<string> {
  const reader = request.body?.getReader(); assert(reader);
  let length = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 65536) { await reader.cancel(); throw new HttpError(413, 'Request too large'); } chunks.push(value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export async function body(request: Request): Promise<any> {
  assert(request.headers.get('content-type')?.split(';')[0] === 'application/json', 415, 'JSON required');
  const text = await boundedText(request);
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
export function csrf(request: Request, origin: string) {
  assert(request.headers.get('Origin') === origin, 403, 'Origin rejected');
  assert(request.headers.get('Sec-Fetch-Site') !== 'cross-site', 403, 'Cross-site request rejected');
}
export async function session(request: Request, env: Env) {
  const token = cookie(request, '__Host-owner');
  if (!token) return null;
  return env.DB.prepare('SELECT w.owner_id,w.auth_epoch,w.created_at,w.digest FROM web_sessions w JOIN auth_state a ON a.id=1 JOIN owner o ON o.id=w.owner_id WHERE w.digest=? AND w.expires_at>? AND w.auth_epoch=a.auth_epoch').bind(await digest(token), now()).first<{ owner_id: number; auth_epoch: number; created_at: number; digest: string }>();
}
