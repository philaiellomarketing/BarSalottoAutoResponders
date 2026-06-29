/**
 * Cloudflare Pages Function — Bar Salotto Gmail actions
 * POST /api/gmail
 *
 * Supported actions: list | create_draft | archive | trash | flag
 *
 * Required KV (BS_KV):
 *   bs:gmail:credentials = {"client_id":"...","client_secret":"...","refresh_token":"..."}
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function onRequestPost(context) {
  const { request, env } = context;

  const origin = request.headers.get('Origin') || '';
  const allowedOrigins = [
    'https://barsalottoautoresponders.pages.dev',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400, corsHeaders); }

  const { action, id, threadId: bodyThreadId, to, subject, body: draftBody, flagged } = body;

  const creds = await getCredentials(env);
  if (!creds) {
    return json({ error: 'gmail_not_configured', fallback: true }, 503, corsHeaders);
  }

  // Lightweight: report which account is connected (no token refresh needed)
  if (action === 'whoami') {
    let email = '', gbpEmail = '';
    try { email = (await env.BS_KV.get('bs:connected:email:gmail')) || (await env.BS_KV.get('bs:connected:email')) || ''; } catch {}
    try { gbpEmail = (await env.BS_KV.get('bs:connected:email:gbp')) || ''; } catch {}
    return json({ email, gbpEmail }, 200, corsHeaders);
  }

  let accessToken;
  try { accessToken = await refreshAccessToken(creds); }
  catch (e) { return json({ error: 'token_refresh_failed', detail: e.message }, 502, corsHeaders); }

  if (action === 'list') {
    return handleListInbox(accessToken, env, corsHeaders);
  }

  // For all other actions, resolve Gmail thread ID (from request or KV cache)
  const threadId = bodyThreadId || await getThreadId(env, id);

  switch (action) {
    case 'send':         return handleSend(accessToken, to, subject, draftBody, threadId, corsHeaders);
    case 'create_draft': return handleCreateDraft(accessToken, to, subject, draftBody, threadId, corsHeaders);
    case 'archive':      return handleArchive(accessToken, threadId, corsHeaders);
    case 'trash':        return handleTrash(accessToken, threadId, corsHeaders);
    case 'flag':         return handleFlag(accessToken, threadId, flagged, corsHeaders);
    default:             return json({ error: 'unknown_action' }, 400, corsHeaders);
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

// ── Inbox list ────────────────────────────────────────────────────────────────

async function handleListInbox(accessToken, env, corsHeaders) {
  const q = encodeURIComponent('in:inbox -in:trash -in:spam newer_than:30d');
  const listRes = await gmailFetch(accessToken, 'GET', `/users/me/threads?q=${q}&maxResults=25`);
  if (!listRes.ok) {
    return json({ error: 'list_failed', status: listRes.status, detail: await listRes.text() }, listRes.status, corsHeaders);
  }
  const { threads = [] } = await listRes.json();

  const items = (await Promise.all(
    threads.map(t => fetchThreadItem(t.id, t.snippet, accessToken, env))
  )).filter(Boolean);

  return json({ items }, 200, corsHeaders);
}

async function fetchThreadItem(id, listSnippet, accessToken, env) {
  const res = await gmailFetch(accessToken, 'GET', `/users/me/threads/${id}?format=full`);
  if (!res.ok) return null;
  const thread = await res.json();

  const firstMsg = thread.messages?.[0];
  if (!firstMsg) return null;

  const hdrs = {};
  for (const h of (firstMsg.payload?.headers || [])) hdrs[h.name.toLowerCase()] = h.value;

  const subject = hdrs.subject || '(no subject)';
  const from    = hdrs.from    || '';
  const date    = hdrs.date    || '';
  const snippet = listSnippet  || firstMsg.snippet || '';
  const fullBody = extractBody(firstMsg.payload) || snippet;
  const starred  = (firstMsg.labelIds || []).includes('STARRED');

  const { name: senderName, email: senderEmail } = parseFrom(from);
  const category = categorize(subject, from, `${snippet} ${fullBody}`);
  const draft    = generateDraft(category, senderName);

  // Cache thread ID in KV so archive/trash/flag actions can resolve it
  if (env.BS_KV) {
    env.BS_KV.put(`bs:thread:${id}`, id, { expirationTtl: 86400 * 14 }).catch(() => {});
  }

  let dateISO = '';
  try { dateISO = new Date(date).toISOString(); } catch {}

  return {
    id,
    threadId:  id,
    sender:    senderName || senderEmail,
    email:     senderEmail || null,
    subject,
    date:      fmtDate(date),
    dateISO,
    snippet,
    body:      fullBody,
    category,
    draft,
    priority:  priorityFor(category),
    flagged:   starred,
    creator:   null,
  };
}

// Walk a Gmail payload tree and return the best plain-text body
function extractBody(payload) {
  if (!payload) return '';
  const decode = (data) => {
    try {
      const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch { return ''; }
  };
  const stripHtml = (html) => html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();

  // Prefer text/plain, then text/html, walking nested parts
  const find = (node, mime) => {
    if (node.mimeType === mime && node.body?.data) return decode(node.body.data);
    for (const p of (node.parts || [])) {
      const r = find(p, mime);
      if (r) return r;
    }
    return '';
  };
  const plain = find(payload, 'text/plain');
  if (plain) return plain.replace(/\n{3,}/g, '\n\n').trim();
  const html = find(payload, 'text/html');
  if (html) return stripHtml(html);
  if (payload.body?.data) return decode(payload.body.data).trim();
  return '';
}

// ── Categorisation & draft generation ────────────────────────────────────────

function categorize(subject, from, snippet) {
  const t = `${subject} ${from} ${snippet}`.toLowerCase();
  if (/reply\+[^@]+@messaging\.yelp\.com/i.test(from))                                                return 'review';
  if (/\b(resume|appl(y|ication|icant)|job inquiry|position|hiring|employment|candidate|cover letter|looking for work)\b/.test(t)) return 'job';
  if (/\b(cater|catering|bulk order|large order|food for \d+)\b/.test(t))                             return 'catering';
  if (/\b(private event|event inquiry|party of|group of \d+|birthday|bridal shower|baby shower|rehearsal|corporate event|book.*event|host.*event|event.*book)\b/.test(t)) return 'dining';
  if (/\b(influencer|content creator|collab|collaboration|media kit|instagram|tiktok|youtube|reel|blog|partnership.*visit|visit.*content)\b/.test(t)) return 'creator';
  if (/\b(donat(e|ion)|charity|fundrais|nonprofit|non-profit|501\(?c\)?|benefit dinner|auction|gala)\b/.test(t)) return 'donation';
  return 'vendor';
}

function priorityFor(cat) {
  return { dining: 'high', catering: 'high', creator: 'medium', review: 'medium', job: 'low', donation: 'low', vendor: 'low' }[cat] || 'low';
}

function parseFrom(from) {
  const m = from.match(/^"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const e = from.match(/^([a-zA-Z0-9._%+\-]+@[^\s]+)$/);
  if (e) return { name: '', email: e[1] };
  return { name: from, email: '' };
}

function fmtDate(rfc) {
  try { return new Date(rfc).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

const SIGNATURE =
  '\n\nPhil\n' +
  'Manager, Bar Salotto\n' +
  '(224) 587-8159 · ciao@barsalotto.com\n' +
  '1421 N. Rand Road, Arlington Heights, IL 60004\n' +
  'barsalotto.com';

function generateDraft(category, senderName) {
  const first = (senderName || '').split(' ')[0];
  const hi   = first ? `Hi ${first} —\n\n` : 'Hello,\n\n';
  const ciao = first ? `Ciao ${first},\n\n` : 'Ciao,\n\n';
  const sig  = SIGNATURE;

  switch (category) {
    case 'job':
      return `Hello,\n\nThank you for your interest in joining the team at Bar Salotto. We truly appreciate you taking the time to reach out.\n\nAt this time, we are not actively hiring. However, we will keep your information on file and reach out if a suitable position becomes available.\n\nWarm regards,${sig}`;

    case 'dining':
      return `${ciao}Thank you for your interest in hosting your event at Bar Salotto — we'd love to be part of your special occasion!\n\nTo check availability and start the booking process, please complete our inquiry form at barsalotto.com/events. Event bookings are handled through our reservation system to make sure we capture all the details and get back to you promptly.\n\nWe look forward to hearing from you!${sig}`;

    case 'catering':
      return `${hi}Thank you for thinking of Bar Salotto for your event — we'd love to help!\n\nYou can browse our catering menu and place your order at barsalotto.com/order-catering. We ask for up to 24 hours lead time before your desired pickup time. If you have specific questions about menu items, gluten-free options, or quantities, feel free to reply and I'll be happy to help.${sig}`;

    case 'creator':
      return `${hi}Thank you for reaching out — we love connecting with creators in our community!\n\nWe'd be open to exploring something together. Could you share a bit more about what you had in mind and your availability? Looking forward to hearing more.${sig}`;

    case 'donation':
      return `Hello,\n\nThank you for your email. Our donation inquiries are handled through our online form at barsalotto.com/donation — requests submitted outside of that form are not reviewed.\n\nIf you've already submitted via the form, our team will be in touch. Please note that donation funds are limited and allocated on a first-come, first-served basis following January 1 each year.\n\nThank you for your understanding.${sig}`;

    case 'review':
      return `${hi}Thank you so much for sharing your experience — it truly means a lot to us here at Bar Salotto. We hope to welcome you back very soon!${sig}`;

    case 'vendor':
    default:
      return `Hello,\n\nThank you for contacting Bar Salotto. Our general inbox is reserved for guest-related matters and we do not review vendor solicitations, marketing proposals, or business outreach through this channel.\n\nWe kindly ask that you discontinue further solicitation emails to this address.\n\nThank you for your understanding.${sig}`;
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleSend(accessToken, to, subject, body, threadId, corsHeaders) {
  if (!to)   return json({ error: 'missing_recipient' }, 400, corsHeaders);
  if (!body) return json({ error: 'empty_body' }, 400, corsHeaders);

  // For proper threading, look up the original message's Message-ID
  let inReplyTo = '', references = '';
  if (threadId) {
    try {
      const tRes = await gmailFetch(accessToken, 'GET',
        `/users/me/threads/${threadId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
      if (tRes.ok) {
        const t = await tRes.json();
        const last = t.messages?.[t.messages.length - 1];
        for (const h of (last?.payload?.headers || [])) {
          if (h.name.toLowerCase() === 'message-id') inReplyTo = h.value;
          if (h.name.toLowerCase() === 'references') references = h.value;
        }
      }
    } catch {}
  }

  const raw = buildMimeMessage(to, subject, body, { inReplyTo, references });
  const payload = { raw };
  if (threadId) payload.threadId = threadId;

  const res = await gmailFetch(accessToken, 'POST', '/users/me/messages/send', payload);
  if (!res.ok) {
    return json({ error: 'send_failed', detail: await res.json().catch(() => ({})) }, res.status, corsHeaders);
  }
  const data = await res.json();
  return json({ ok: true, messageId: data.id }, 200, corsHeaders);
}

async function handleCreateDraft(accessToken, to, subject, body, threadId, corsHeaders) {
  const raw = buildMimeMessage(to, subject, body);
  const payload = { message: { raw } };
  if (threadId) payload.message.threadId = threadId;

  const res = await gmailFetch(accessToken, 'POST', '/users/me/drafts', payload);
  if (!res.ok) {
    return json({ error: 'draft_failed', detail: await res.json().catch(() => ({})) }, res.status, corsHeaders);
  }
  const data = await res.json();
  return json({ ok: true, draftId: data.id }, 200, corsHeaders);
}

async function handleArchive(accessToken, threadId, corsHeaders) {
  if (!threadId) return json({ ok: true, note: 'no_thread_id' }, 200, corsHeaders);
  const res = await gmailFetch(accessToken, 'POST', `/users/me/threads/${threadId}/modify`, {
    removeLabelIds: ['INBOX'],
  });
  if (!res.ok) return json({ error: 'archive_failed', detail: await res.json().catch(() => ({})) }, res.status, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

async function handleTrash(accessToken, threadId, corsHeaders) {
  if (!threadId) return json({ ok: true, note: 'no_thread_id' }, 200, corsHeaders);
  const res = await gmailFetch(accessToken, 'POST', `/users/me/threads/${threadId}/trash`);
  if (!res.ok) return json({ error: 'trash_failed', detail: await res.json().catch(() => ({})) }, res.status, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

async function handleFlag(accessToken, threadId, flagged, corsHeaders) {
  if (!threadId) return json({ ok: true, note: 'no_thread_id' }, 200, corsHeaders);
  const body = flagged ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] };
  const res = await gmailFetch(accessToken, 'POST', `/users/me/threads/${threadId}/modify`, body);
  if (!res.ok) return json({ error: 'flag_failed', detail: await res.json().catch(() => ({})) }, res.status, corsHeaders);
  return json({ ok: true }, 200, corsHeaders);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCredentials(env) {
  if (!env.BS_KV) return null;
  try {
    const raw = await env.BS_KV.get('bs:gmail:credentials');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function getThreadId(env, itemId) {
  if (!env.BS_KV) return null;
  try { return await env.BS_KV.get(`bs:thread:${itemId}`); }
  catch { return null; }
}

async function refreshAccessToken({ client_id, client_secret, refresh_token }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id, client_secret, refresh_token }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).access_token;
}

async function gmailFetch(accessToken, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${GMAIL_API}${path}`, opts);
}

function buildMimeMessage(to, subject, bodyText, threading = {}) {
  const from = 'ciao@barsalotto.com';
  const { inReplyTo, references } = threading;
  const refs = [references, inReplyTo].filter(Boolean).join(' ');
  const mime = [
    `From: Phil <${from}>`,
    to ? `To: ${to}` : '',
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    refs ? `References: ${refs}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    bodyText,
  ].filter(Boolean).join('\r\n');
  return btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
