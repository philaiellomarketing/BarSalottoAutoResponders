/**
 * Cloudflare Pages Function — Google OAuth callback
 * GET /api/oauth/callback?code=...&state=gmail|gbp|both
 *
 * Exchanges the auth code for a refresh token and stores it under the KV key(s)
 * for the connected service(s). `state` tells us which service was requested:
 *   gmail → bs:gmail:credentials
 *   gbp   → bs:gbp:credentials (+ clears bs:gbp:location)
 *   both  → both keys
 * Records the connected account email per service, then redirects back with a
 * status flag.
 */

const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code    = url.searchParams.get('code');
  const error   = url.searchParams.get('error');
  const service = ['gmail', 'gbp', 'both'].includes(url.searchParams.get('state'))
    ? url.searchParams.get('state') : 'both';
  const redirectUri = `${url.origin}/api/oauth/callback`;

  // GBP connection failures land back on the reviews page; others on the inbox
  const dest = service === 'gbp' ? '/dashboard/reviews.html' : '/dashboard/';
  const back = (status, extra = '') =>
    Response.redirect(`${url.origin}${dest}?connected=${status}&service=${service}${extra}`, 302);

  if (error) return back('error', `&reason=${encodeURIComponent(error)}`);
  if (!code)  return back('error', '&reason=no_code');

  // Need client_id + client_secret to exchange the code
  let clientId = env.GOOGLE_CLIENT_ID || '';
  let clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  if ((!clientId || !clientSecret) && env.BS_KV) {
    for (const key of ['bs:gmail:credentials', 'bs:gbp:credentials']) {
      try {
        const c = JSON.parse(await env.BS_KV.get(key) || '{}');
        clientId = clientId || c.client_id || '';
        clientSecret = clientSecret || c.client_secret || '';
      } catch {}
    }
  }
  if (!clientId || !clientSecret) return back('error', '&reason=no_client_credentials');

  const tokRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokRes.ok) {
    const detail = (await tokRes.text()).slice(0, 140);
    return back('error', `&reason=${encodeURIComponent(detail)}`);
  }
  const tok = await tokRes.json();
  if (!tok.refresh_token) return back('error', '&reason=no_refresh_token_returned');

  let email = '';
  try {
    const me = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (me.ok) email = (await me.json()).email || '';
  } catch {}

  if (!env.BS_KV) return back('error', '&reason=kv_not_bound');

  const creds = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tok.refresh_token,
  });

  if (service === 'gmail' || service === 'both') {
    await env.BS_KV.put('bs:gmail:credentials', creds);
    if (email) await env.BS_KV.put('bs:connected:email:gmail', email);
  }
  if (service === 'gbp' || service === 'both') {
    await env.BS_KV.put('bs:gbp:credentials', creds);
    await env.BS_KV.delete('bs:gbp:location'); // re-resolve business for the new account
    if (email) await env.BS_KV.put('bs:connected:email:gbp', email);
  }
  // Back-compat key used by older whoami
  if (email) await env.BS_KV.put('bs:connected:email', email);

  return back('ok', email ? `&email=${encodeURIComponent(email)}` : '');
}
