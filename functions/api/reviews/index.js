/**
 * Cloudflare Pages Function — Bar Salotto Google reviews
 * POST /api/reviews
 *
 * Actions:
 *   list   → { answered: [...], unanswered: [...], meta: {...} }
 *   reply  → posts a reply to a review  { reviewName, comment }
 *
 * Uses the Google Business Profile APIs:
 *   - Account Management API  (discover account)
 *   - Business Information API (discover location)
 *   - My Business v4          (reviews list + reply — reviews still live on v4)
 *
 * Required KV (BS_KV):
 *   bs:gbp:credentials = {"client_id":"...","client_secret":"...","refresh_token":"..."}
 *   bs:gbp:location    = (auto-cached) "accounts/{id}/locations/{id}"
 *
 * OAuth scope needed when generating the refresh token:
 *   https://www.googleapis.com/auth/business.manage
 *
 * NOTE: Access to these APIs must first be approved by Google. See
 *       docs/GOOGLE_BUSINESS_PROFILE_SETUP.md.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCT_API  = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API  = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const MB_V4      = 'https://mybusiness.googleapis.com/v4';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeaders(request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid_json' }, 400, cors); }

  const creds = await getCredentials(env);
  if (!creds) {
    return json({ error: 'gbp_not_configured', fallback: true }, 503, cors);
  }

  let token;
  try { token = await refreshAccessToken(creds); }
  catch (e) { return json({ error: 'token_refresh_failed', detail: e.message }, 502, cors); }

  // These actions don't need a resolved location
  if (body.action === 'locations') {
    try { return json({ locations: await listAllLocations(token) }, 200, cors); }
    catch (e) { return json({ error: 'locations_failed', detail: e.message }, 502, cors); }
  }
  if (body.action === 'set_location') {
    if (!body.locationPath) return json({ error: 'missing_location' }, 400, cors);
    if (env.BS_KV) await env.BS_KV.put('bs:gbp:location', body.locationPath);
    return json({ ok: true, locationPath: body.locationPath }, 200, cors);
  }

  // Resolve (and cache) the account/location resource path
  let locationPath;
  try { locationPath = await resolveLocation(env, token); }
  catch (e) { return json({ error: 'location_lookup_failed', detail: e.message }, 502, cors); }

  switch (body.action) {
    case 'list':  return listReviews(token, locationPath, cors);
    case 'reply': return replyToReview(token, body.reviewName, body.comment, cors);
    default:      return json({ error: 'unknown_action' }, 400, cors);
  }
}

// List every account → location the connected user manages, with titles, so the
// dashboard can show which business is selected and let the owner switch.
async function listAllLocations(token) {
  const out = [];
  const acctRes = await fetch(`${ACCT_API}/accounts`, { headers: { Authorization: `Bearer ${token}` } });
  if (!acctRes.ok) throw new Error(`accounts ${acctRes.status}: ${await acctRes.text()}`);
  const accounts = (await acctRes.json()).accounts || [];
  for (const acct of accounts) {
    const accountId = acct.name.split('/')[1];
    let pageToken = '';
    do {
      const url = `${INFO_API}/accounts/${accountId}/locations?readMask=name,title,storefrontAddress&pageSize=100`
        + (pageToken ? `&pageToken=${pageToken}` : '');
      const locRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!locRes.ok) break;
      const data = await locRes.json();
      for (const loc of (data.locations || [])) {
        const locId = loc.name.split('/').pop();
        const addr = loc.storefrontAddress
          ? [loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].filter(Boolean).join(', ')
          : '';
        out.push({
          path: `accounts/${accountId}/locations/${locId}`,
          title: loc.title || '(unnamed location)',
          address: addr,
          account: acct.accountName || accountId,
        });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function listReviews(token, locationPath, cors) {
  const all = [];
  let pageToken = '';
  do {
    const url = `${MB_V4}/${locationPath}/reviews?pageSize=50` +
                (pageToken ? `&pageToken=${pageToken}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = await res.text();
      return json({ error: 'reviews_fetch_failed', status: res.status, detail }, res.status, cors);
    }
    const data = await res.json();
    (data.reviews || []).forEach(r => all.push(normalizeReview(r, locationPath)));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const answered   = all.filter(r => r.ownerReply);
  const unanswered = all.filter(r => !r.ownerReply);

  // Learn from Phil's real replies: build a corpus from answered reviews and
  // generate a suggested reply for each unanswered one in his actual voice,
  // with a 0–10 confidence ("match") score.
  const corpus = answered
    .filter(r => r.ownerReply && (r.comment || '').trim().length)
    .map(r => ({ stars: r.stars, comment: r.comment, reply: r.ownerReply, reviewer: r.reviewer }));

  unanswered.forEach(r => {
    const s = buildSuggestion(r, corpus);
    r.suggested = s.text;
    r.matchScore = s.score;
    r.care = s.care;
  });

  return json({
    answered,
    unanswered,
    meta: { total: all.length, answered: answered.length, unanswered: unanswered.length,
            locationPath, corpusSize: corpus.length },
  }, 200, cors);
}

// ── Suggestion engine (learns from past replies) ──────────────────────────────

const STOP = new Set(('the a an and or but for to of in on at is was were are be been have has had ' +
  'we our you your i it this that they them so very really just with my me as at had also got out ' +
  'their there here what when from than then too not no yes will would can could about into over').split(/\s+/));

function tokenize(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w)))];
}
function firstNameOf(n) {
  if (!n || /^a google user$/i.test(n)) return '';
  return n.trim().split(/\s+/)[0];
}
function band(stars) {
  if (stars == null) return 'pos';
  if (stars >= 4) return 'pos';
  if (stars === 3) return 'neu';
  return 'neg';
}

function buildSuggestion(review, corpus) {
  const b = band(review.stars);
  const currFirst = firstNameOf(review.reviewer);
  const rTokens = tokenize(review.comment);

  // Negative reviews: only ever mirror past negative replies; never a 5★ reply.
  let pool = corpus.filter(c => band(c.stars) === b);
  if (b === 'neg' && !pool.length) return { text: carefulNegative(currFirst), score: 5, care: true };
  if (!pool.length) pool = corpus;
  if (!pool.length) {
    return b === 'neg'
      ? { text: carefulNegative(currFirst), score: 5, care: true }
      : { text: defaultPositive(currFirst), score: 4, care: false };
  }

  let best = null, bestOverlap = -1;
  for (const c of pool) {
    const cTokens = tokenize(c.comment);
    const overlap = rTokens.filter(t => cTokens.includes(t)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = c; }
  }

  const text = adaptReply(best.reply, firstNameOf(best.reviewer), currFirst);
  const denom = Math.max(rTokens.length, 3);
  let score = Math.round(Math.min(10, 4 + (bestOverlap / denom) * 8));
  if (band(best.stars) !== b) score = Math.max(3, score - 3);   // cross-band borrow → less confident
  if (!rTokens.length) score = Math.min(score, 5);              // rating-only review → low confidence
  const care = (b === 'neg');
  if (care) score = Math.min(score, 7);
  return { text, score, care };
}

function adaptReply(reply, pastFirst, currFirst) {
  let t = String(reply || '');
  if (pastFirst) {
    const esc = pastFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (currFirst) {
      t = t.replace(new RegExp(`\\b${esc}\\b`, 'g'), currFirst);
    } else {
      // drop the name gracefully when the new reviewer is anonymous
      t = t.replace(new RegExp(`,?\\s*\\b${esc}\\b`, 'g'), '')
           .replace(/\s{2,}/g, ' ').replace(/\s+([!.,?])/g, '$1');
    }
  }
  return t.trim();
}

function carefulNegative(name) {
  const n = name ? `, ${name}` : '';
  return `We're so sorry to hear about your experience${n} — this isn't the standard we hold ourselves to, ` +
    `and we take your feedback seriously. We'd genuinely like to make it right; please reach out to us at ` +
    `ciao@barsalotto.com so we can follow up personally.`;
}
function defaultPositive(name) {
  const n = name ? `, ${name}` : '';
  return `Thank you so much${n}! We're thrilled you enjoyed your visit to Bar Salotto — it means the world to ` +
    `our family, and we can't wait to welcome you back.`;
}

async function replyToReview(token, reviewName, comment, cors) {
  if (!reviewName || !comment) {
    return json({ error: 'missing_fields', need: ['reviewName', 'comment'] }, 400, cors);
  }
  const res = await fetch(`${MB_V4}/${reviewName}/reply`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'reply_failed', status: res.status, detail }, res.status, cors);
  }
  return json({ ok: true }, 200, cors);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function normalizeReview(r, locationPath) {
  return {
    reviewName: `${locationPath}/reviews/${r.reviewId}`,
    reviewId:   r.reviewId,
    reviewer:   r.reviewer?.displayName || 'A Google user',
    stars:      STAR_MAP[r.starRating] || null,
    comment:    r.comment || '',
    createTime: r.createTime,
    ownerReply: r.reviewReply ? r.reviewReply.comment : null,
  };
}

async function getCredentials(env) {
  if (!env.BS_KV) return null;
  try {
    const raw = await env.BS_KV.get('bs:gbp:credentials');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function resolveLocation(env, token) {
  // Cached?
  if (env.BS_KV) {
    const cached = await env.BS_KV.get('bs:gbp:location');
    if (cached) return cached;
  }

  // 1. First account
  const acctRes = await fetch(`${ACCT_API}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!acctRes.ok) throw new Error(`accounts ${acctRes.status}: ${await acctRes.text()}`);
  const accounts = (await acctRes.json()).accounts || [];
  if (!accounts.length) throw new Error('no_accounts');
  const accountId = accounts[0].name.split('/')[1]; // "accounts/{id}"

  // 2. First location under that account
  const locUrl = `${INFO_API}/accounts/${accountId}/locations?readMask=name,title&pageSize=10`;
  const locRes = await fetch(locUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!locRes.ok) throw new Error(`locations ${locRes.status}: ${await locRes.text()}`);
  const locations = (await locRes.json()).locations || [];
  if (!locations.length) throw new Error('no_locations');
  const locationId = locations[0].name.split('/').pop(); // "locations/{id}"

  const path = `accounts/${accountId}/locations/${locationId}`;
  if (env.BS_KV) await env.BS_KV.put('bs:gbp:location', path, { expirationTtl: 86400 });
  return path;
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

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [
    'https://barsalottoautoresponders.pages.dev',
    'http://localhost', 'http://127.0.0.1',
  ];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}
