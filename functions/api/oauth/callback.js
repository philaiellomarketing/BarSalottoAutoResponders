/**
 * Cloudflare Pages Function — Google OAuth callback
 * GET /api/oauth/callback?code=...
 *
 * Exchanges the auth code for a refresh token, stores it in KV under BOTH
 * bs:gmail:credentials and bs:gbp:credentials (one Google account powers both),
 * clears the cached business location, records the connected email, then
 * redirects back to the dashboard with a status flag.
 */

const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const redirectUri = `${url.origin}/api/oauth/callback`;
  const back = (status, extra = '') =>
    Response.redirect(`${url.origin}/dashboard/?connected=${status}${extra}`, 302);

  if (error) return back('error', `&reason=${encodeURIComponent(error)}`);
  if (!code)  return back('error', '&reason=no_code');

  // Need client_id + client_secret to exchange the code
  let clientId = env.GOOGLE_CLIENT_ID || '';
  let clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  if ((!clientId || !clientSecret) && env.BS_KV) {
    try {
      const c = JSON.parse(await env.BS_KV.get('bs:gmail:credentials') || '{}');
      clientId = clientId || c.client_id || '';
      clientSecret = clientSecret || c.client_secret || '';
    } catch {}
  }
  if (!clientId || !clientSecret) return back('error', '&reason=no_client_credentials');

  // Exchange auth code for tokens
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
  if (!tok.refresh_token) {
    return back('error', '&reason=no_refresh_token_returned');
  }

  // Look up which account just authorized (for display)
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

  // One Google account drives both Gmail and Google Business Profile
  await env.BS_KV.put('bs:gmail:credentials', creds);
  await env.BS_KV.put('bs:gbp:credentials', creds);
  // Force the reviews Function to re-resolve the business location for the new account
  await env.BS_KV.delete('bs:gbp:location');
  if (email) await env.BS_KV.put('bs:connected:email', email);

  return back('ok', email ? `&email=${encodeURIComponent(email)}` : '');
}
