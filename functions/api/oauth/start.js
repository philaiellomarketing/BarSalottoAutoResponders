/**
 * Cloudflare Pages Function — start Google OAuth
 * GET /api/oauth/start?service=gmail|gbp|both   (default: both)
 *
 * Redirects the browser to Google's consent screen. The `service` param picks
 * which scopes are requested so Gmail and Google Business Profile can be
 * connected to DIFFERENT Google accounts if needed. `openid email` is always
 * requested so we can record which account got connected. access_type=offline +
 * prompt=consent force a fresh refresh token every time (needed when switching).
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPE_SETS = {
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  gbp:   ['https://www.googleapis.com/auth/business.manage'],
  both:  ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/business.manage'],
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const service = ['gmail', 'gbp', 'both'].includes(url.searchParams.get('service'))
    ? url.searchParams.get('service') : 'both';
  const redirectUri = `${url.origin}/api/oauth/callback`;

  let clientId = env.GOOGLE_CLIENT_ID || '';
  if (!clientId && env.BS_KV) {
    try { clientId = JSON.parse(await env.BS_KV.get('bs:gmail:credentials') || '{}').client_id || ''; }
    catch {}
  }
  if (!clientId && env.BS_KV) {
    try { clientId = JSON.parse(await env.BS_KV.get('bs:gbp:credentials') || '{}').client_id || ''; }
    catch {}
  }
  if (!clientId) {
    return new Response('No OAuth client_id configured in KV or env.', { status: 500 });
  }

  const scope = ['openid', 'email', ...SCOPE_SETS[service]].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: service,
  });

  return Response.redirect(`${AUTH_URL}?${params.toString()}`, 302);
}
