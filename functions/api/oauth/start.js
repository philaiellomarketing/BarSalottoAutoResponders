/**
 * Cloudflare Pages Function — start Google OAuth
 * GET /api/oauth/start
 *
 * Redirects the browser to Google's consent screen. Requests both Gmail and
 * Google Business Profile scopes plus `openid email` so we can show which
 * account got connected. Uses access_type=offline + prompt=consent to force a
 * fresh refresh token every time (needed when switching accounts).
 *
 * Reads client_id from KV (bs:gmail:credentials) or env.GOOGLE_CLIENT_ID.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/business.manage',
].join(' ');

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/oauth/callback`;

  let clientId = env.GOOGLE_CLIENT_ID || '';
  if (!clientId && env.BS_KV) {
    try { clientId = JSON.parse(await env.BS_KV.get('bs:gmail:credentials') || '{}').client_id || ''; }
    catch {}
  }
  if (!clientId) {
    return new Response('No OAuth client_id configured in KV (bs:gmail:credentials) or env.', { status: 500 });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });

  return Response.redirect(`${AUTH_URL}?${params.toString()}`, 302);
}
