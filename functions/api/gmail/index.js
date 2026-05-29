/**
 * Cloudflare Pages Function — Bar Salotto Gmail actions
 * POST /api/bar-salotto/gmail
 *
 * Supported actions: create_draft | archive | trash | flag
 *
 * Required KV bindings (add to wrangler.toml):
 *   BS_KV — stores { gmail_refresh_token, gmail_client_id, gmail_client_secret }
 *           under key "bs:gmail:credentials"
 *
 * Setup (one-time):
 *   1. Create a Google Cloud project at console.cloud.google.com
 *   2. Enable the Gmail API
 *   3. Create OAuth 2.0 credentials (Desktop app type)
 *   4. Complete OAuth flow to get a refresh token
 *      (use https://developers.google.com/oauthplayground with your client ID)
 *   5. Store in KV:
 *      wrangler kv key put --binding=BS_KV "bs:gmail:credentials" \
 *        '{"client_id":"...","client_secret":"...","refresh_token":"..."}'
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS for local dev / dashboard origin
  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://land-of-sigma-pi.pages.dev',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400, corsHeaders);
  }

  const { action, id, to, subject, body: draftBody, flagged } = body;

  // Load Gmail credentials from KV
  const creds = await getCredentials(env);
  if (!creds) {
    // Return 503 so the dashboard knows to fall back to mailto
    return json({ error: 'gmail_not_configured', fallback: true }, 503, corsHeaders);
  }

  let accessToken;
  try {
    accessToken = await refreshAccessToken(creds);
  } catch (e) {
    return json({ error: 'token_refresh_failed', detail: e.message }, 502, corsHeaders);
  }

  // Resolve Gmail thread ID if we have it stored
  const threadId = await getThreadId(env, id);

  switch (action) {
    case 'create_draft':
      return handleCreateDraft(accessToken, to, subject, draftBody, threadId, corsHeaders);
    case 'archive':
      return handleArchive(accessToken, threadId, id, env, corsHeaders);
    case 'trash':
      return handleTrash(accessToken, threadId, id, env, corsHeaders);
    case 'flag':
      return handleFlag(accessToken, threadId, flagged, corsHeaders);
    default:
      return json({ error: 'unknown_action' }, 400, corsHeaders);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleCreateDraft(accessToken, to, subject, body, threadId, corsHeaders) {
  const raw = buildMimeMessage(to, subject, body);
  const payload = { message: { raw } };
  if (threadId) payload.message.threadId = threadId;

  const res = await gmailFetch(accessToken, 'POST', '/users/me/drafts', payload);
  if (!res.ok) {
    const err = await res.json();
    return json({ error: 'draft_failed', detail: err }, res.status, corsHeaders);
  }
  const data = await res.json();
  return json({ ok: true, draftId: data.id }, 200, corsHeaders);
}

async function handleArchive(accessToken, threadId, id, env, corsHeaders) {
  if (!threadId) return json({ ok: true, note: 'no_thread_id' }, 200, corsHeaders);

  const res = await gmailFetch(accessToken, 'POST', `/users/me/threads/${threadId}/modify`, {
    removeLabelIds: ['INBOX'],
  });
  if (!res.ok) {
    const err = await res.json();
    return json({ error: 'archive_failed', detail: err }, res.status, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

async function handleTrash(accessToken, threadId, id, env, corsHeaders) {
  if (!threadId) return json({ ok: true, note: 'no_thread_id' }, 200, corsHeaders);

  const res = await gmailFetch(accessToken, 'POST', `/users/me/threads/${threadId}/trash`);
  if (!res.ok) {
    const err = await res.json();
    return json({ error: 'trash_failed', detail: err }, res.status, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

async function handleFlag(accessToken, threadId, flagged, corsHeaders) {
  if (!threadId) return json({ ok: true, note: 'no_thread_id' }, 200, corsHeaders);

  const body = flagged
    ? { addLabelIds: ['STARRED'] }
    : { removeLabelIds: ['STARRED'] };

  const res = await gmailFetch(accessToken, 'POST', `/users/me/threads/${threadId}/modify`, body);
  if (!res.ok) {
    const err = await res.json();
    return json({ error: 'flag_failed', detail: err }, res.status, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCredentials(env) {
  if (!env.BS_KV) return null;
  try {
    const raw = await env.BS_KV.get('bs:gmail:credentials');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function getThreadId(env, itemId) {
  if (!env.BS_KV) return null;
  try {
    return await env.BS_KV.get(`bs:thread:${itemId}`);
  } catch {
    return null;
  }
}

async function refreshAccessToken({ client_id, client_secret, refresh_token }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id,
      client_secret,
      refresh_token,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const { access_token } = await res.json();
  return access_token;
}

async function gmailFetch(accessToken, method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${GMAIL_API}${path}`, opts);
}

function buildMimeMessage(to, subject, bodyText) {
  const from = 'ciao@barsalotto.com';
  const mime = [
    `From: Phil <${from}>`,
    to ? `To: ${to}` : '',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    bodyText,
  ].filter(Boolean).join('\r\n');

  // Base64url encode
  return btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
