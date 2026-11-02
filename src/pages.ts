import { escape, random } from './common';
export function page(title: string, content: string, script = '') {
  const nonce = random();
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Self-hosted MCP Auth</title><style>body{font:17px system-ui;max-width:700px;margin:8vh auto;padding:24px;line-height:1.6;color:#20272d;background:#fafaf8}input,button{font:inherit;padding:10px;margin:8px 0;max-width:100%;box-sizing:border-box}input[type=password]{width:100%}button{cursor:pointer}code{overflow-wrap:anywhere}#status{white-space:pre-wrap}label{display:block}a{color:#235d94}</style><main><h1>${escape(title)}</h1>${content}<p id="status" role="status"></p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` } });
}
export function authPage(purpose: string, initialized: boolean) {
  const registration = purpose !== 'login';
  if (purpose === 'bootstrap' && initialized) return page('Already set up', '<p>This deployment already has an owner.</p><a href="/login">Sign in</a>');
  const key = purpose === 'bootstrap' || purpose === 'recovery';
  const title = { bootstrap: 'Set up your application', recovery: 'Recover ownership', add: 'Add a Passkey', login: 'Sign in' }[purpose]!;
  const help = key ? `<p>In the Cloudflare Dashboard, open this Worker’s <strong>DB</strong> binding, then the <strong>admin_keys</strong> table. Copy <code>secret_display</code> for <code>${purpose}</code>. It is never shown by this website.</p><label>Owner ${purpose === 'bootstrap' ? 'claim' : 'recovery'} key<input id="key" type="password" autocomplete="off" required></label>` : '';
  const confirmation = purpose === 'bootstrap' ? '<label><input id="confirm" type="checkbox" required> Use <code id="origin"></code> as this deployment’s permanent Passkey and OAuth address.</label>' : '';
  return page(title, `${help}${purpose === 'recovery' ? '<p>After a successful replacement, previous Passkeys, sessions and MCP authorizations stop working. The replacement recovery key will be available only in D1.</p>' : ''}<form id="auth">${confirmation}<button>${registration ? 'Register Passkey' : 'Use Passkey'}</button></form><p><a href="/login">Sign in</a> · <a href="/recover">Recovery instructions</a></p>`, `
const purpose=${JSON.stringify(purpose)};
if(document.querySelector('#origin')) document.querySelector('#origin').textContent=location.origin;
const status=document.querySelector('#status');
async function post(path,value){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
document.querySelector('#auth').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{
if(purpose==='bootstrap'&&!document.querySelector('#confirm').checked)throw Error('Confirm your deployment address first.');
const key=document.querySelector('#key')?.value;
const prepared=await post('/auth/'+purpose+'/options',{key,canonicalOrigin:location.origin});
const options=${registration ? 'PublicKeyCredential.parseCreationOptionsFromJSON' : 'PublicKeyCredential.parseRequestOptionsFromJSON'}(prepared.publicKey);
const credential=await navigator.credentials.${registration ? 'create' : 'get'}({publicKey:options});
await post('/auth/'+purpose+'/finish',{id:prepared.id,key,response:credential.toJSON()});
const target=new URLSearchParams(location.search).get('returnTo'); const destination=new URL(target||'/app',location.origin); location.assign(destination.origin===location.origin?destination.pathname+destination.search+destination.hash:'/app');
}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
`);
}
