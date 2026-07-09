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

  // AI rewrite — independent of Google Business Profile; needs only the Anthropic key.
  if (body.action === 'suggest') {
    const apiKey = env.ANTHROPIC_API_KEY || (env.BS_KV && await env.BS_KV.get('bs:anthropic:key'));
    if (!apiKey) return json({ error: 'ai_not_configured' }, 503, cors);
    try {
      const model = (env.BS_KV && await env.BS_KV.get('bs:anthropic:model')) || 'claude-opus-4-8';
      const text = await aiGenerateReply(body, apiKey, model);
      return json({ ok: true, text }, 200, cors);
    } catch (e) {
      return json({ error: 'ai_failed', detail: e.message }, 502, cors);
    }
  }

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
    const res = await gfetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
    const s = buildSuggestion(r);
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

// ── AI reply generation (Claude) ──────────────────────────────────────────────

const REVIEW_SYSTEM =
`You write Google review replies for Bar Salotto, a family-owned boutique Italian pizza bar in Arlington Heights, IL, on behalf of the owner.

Your #1 job is SPECIFICITY. A reply that could be pasted under any review is a failure. Before writing, pick out the concrete things THIS reviewer named — a dish or pizza, a cocktail or drink, a server or staff member by name, the occasion (date night, birthday, family dinner), or a specific detail about the service or atmosphere — and build the reply around at least one of them, naming it explicitly.

Voice and rules (follow exactly):
- Warm, genuine, family-owned. Grateful without being over-effusive.
- Ground every reply in details from THIS review only. Never invent a dish, drink, or name the reviewer didn't mention, and never carry over specifics from the example replies. If the review truly names nothing specific (rating only, or "great food"), stay warm and general rather than fabricating.
- If the reviewer named a server or staff member, mention them by name and say you'll pass the kind words along.
- Address the reviewer by first name when one is given ("Thank you, Sarah!"). If anonymous, open warmly without a name.
- Positive (4-5 stars): 1-3 sentences. Thank them, name the specific thing they loved, invite them back. A light Italian touch ("Grazie!") is welcome but optional.
- Mixed (3 stars): thank them, acknowledge the specific critique sincerely, signal it's noted, invite them back.
- Negative (1-2 stars): lead with genuine empathy, no defensiveness, never argue facts publicly. Name the specific issue they raised, offer to make it right, and give the direct contact ciao@barsalotto.com. Keep it short and human.

MENU ACCURACY:
- A menu reference is provided. If the reviewer names a dish, pizza, pasta, or cocktail, use the EXACT spelling and capitalization from the menu (e.g. "Spicy Vodka", "Fig & Pig", "Wagyu-Veal Meatballs").
- Only mention a menu item the reviewer actually brought up. Never suggest or name a dish they didn't mention.
- Our chef is Chef Gary Baca — you may reference him warmly when it fits, but don't force it.

HARD RULES:
- NO sign-off of any kind. Do NOT end with "Phil", "— The Bar Salotto Team", "Management", "Warm regards", or any name/role. End on the last sentence of the reply itself.
- No discount codes, freebies, or compensation offered publicly.
- Output ONLY the reply text — no preamble, no quotation marks, no labels.`;

function starWord(n) {
  return ({ 1: 'one-star', 2: 'two-star', 3: 'three-star', 4: 'four-star', 5: 'five-star' })[n] || 'unrated';
}

async function aiGenerateReply({ reviewer, stars, comment, examples }, apiKey, model) {
  const first = firstNameOf(reviewer);
  const list = (examples || []).filter(e => e && e.reply);

  // Pick the closest past reply (by keyword overlap with THIS review) as the tone
  // anchor; the rest illustrate the general voice.
  const rTokens = tokenize(comment);
  let reference = null, bestOverlap = -1;
  for (const e of list) {
    const overlap = tokenize(e.comment).filter(t => rTokens.includes(t)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; reference = e; }
  }
  const rest = list.filter(e => e !== reference).slice(0, 5);

  const refBlock = reference
    ? `CLOSEST PAST REPLY (use its warmth and structure as your starting point, then rewrite it to fit THIS review — do NOT keep its specific dishes/names):\nTheir ${starWord(reference.stars)} review: "${(reference.comment || '').slice(0, 600)}"\nOur reply: "${reference.reply}"\n\n`
    : '';
  const restBlock = rest.length
    ? `More examples of our voice:\n` + rest.map((e, i) =>
        `${i + 1}. (${starWord(e.stars)}) "${(e.comment || '').slice(0, 300)}" → "${e.reply}"`).join('\n') + '\n\n'
    : '';

  const sig = extractSignals(comment);
  const sigHint = (sig.items.length || sig.staff.length || sig.occasion)
    ? `Detected in this review — ${[
        sig.items.length ? `menu items: ${sig.items.join(', ')}` : '',
        sig.staff.length ? `staff named: ${sig.staff.join(', ')}` : '',
        sig.occasion ? `occasion: ${sig.occasion}` : '',
      ].filter(Boolean).join('; ')}. Weave these in (correct any misspellings against the menu). `
    : `This review names nothing specific — keep it warm and general; do NOT invent a dish or detail. `;

  const user =
    refBlock + restBlock +
    `THIS ${starWord(stars)} review${first ? ` from ${first}` : ' (anonymous)'}:\n"${comment || '(rating only, no text)'}"\n\n` +
    sigHint + '\n\n' +
    `Steps (internal):\n` +
    `1. Note the specific things this reviewer named (dishes/drinks by exact menu name, server/staff, occasion, standout service or atmosphere). If none, note that.\n` +
    `2. Write the reply: adopt the closest past reply's warmth, but ground it in step-1 specifics so it unmistakably belongs to THIS review. Address ${first || 'the guest'}${first ? ' by first name' : ''}. No sign-off.\n\n` +
    `Output ONLY the final reply text (not the step-1 notes).`;

  const menuRef = `MENU REFERENCE (exact names for spelling — reference only what the guest mentions):\n` +
    `Chef: ${CHEF}.\nDishes: ${MENU_ITEMS.filter(n => !/Spritz|Mule|Gimlet|Negroni|Martini|Manhattan|Collins|Word|Slush|Sangria|Cooler|Maple|Old Fashioned/.test(n)).join(', ')}.\n` +
    `Cocktails: ${MENU_ITEMS.filter(n => /Spritz|Mule|Gimlet|Negroni|Martini|Manhattan|Collins|Word|Slush|Sangria|Cooler|Maple|Old Fashioned/.test(n)).join(', ')}.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system: [
        { type: 'text', text: REVIEW_SYSTEM },
        { type: 'text', text: menuRef, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + (await res.text()).slice(0, 180));
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('model_refused');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return sanitizeReply(text, firstNameOf(reviewer));
}

function sanitizeReply(text, currFirst) {
  let t = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
  // Strip an accidental sign-off line at the end
  t = t.replace(/\n+\s*(warm regards|best regards|best|sincerely|cheers|with gratitude|— ?the bar salotto team|the bar salotto team|management|phil)[\s,!.\-–—]*$/i, '').trim();
  t = t.replace(/\n+\s*phil\b.*$/i, '').trim();
  // Safety net on any leftover greeting-name mismatch
  t = swapGreetingName(t, currFirst);
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([!.,?])/g, '$1').trim();
}

function buildSuggestion(review) {
  const b = band(review.stars);
  const first = firstNameOf(review.reviewer);
  const sig = extractSignals(review.comment);

  if (b === 'neg') return { text: carefulNegative(first, sig), score: 6, care: true };

  const text = templateReply(first, b, sig);
  // Confidence reflects how much we could ground the reply in THIS review.
  let score = 4;
  if (sig.items.length) score += 3;
  if (sig.staff.length) score += 2;
  if (sig.occasion)     score += 1;
  if (!sig.items.length && !sig.staff.length && !sig.occasion && (review.comment || '').trim()) score = 5;
  if (!(review.comment || '').trim()) score = 3; // rating-only
  return { text: Math.min(score, 10) && text, score: Math.min(score, 10), care: false };
}

// ── Menu awareness (from the Bar Salotto knowledge base) ─────────────────────
const CHEF = 'Chef Gary Baca';
const MENU_ITEMS = [
  // Small bites / boards
  'Wagyu-Veal Meatballs','Stracciatella Toast','Mozzarella Fritta','Imported Burrata','Garlic Puffs','Crispy Eggplant Stack','Butcher Board',
  // Salads
  'Little Gem Caesar','La Salotto Chopped','Tuscan Kale','Hearts of Palm',
  // Pasta / pesce
  'Salmon Genovese','Spicy Vodka','Classic Bolognese','Broccolini Pesto','Shrimp Scampi','Spaghetti & Clams','Truffle Tortellacci',
  // Pizza
  "Grandma's Pie",'Margherita','Florentine','Sausage','Mushroom','Spicy Soppressata','Tadella','The Salotto','Fig & Pig','Pepperoni',
  // Desserts
  'Tiramisu','Affogato','Kiki Skillet','Cinnamon Sugar Puffs','Italian Rainbow Cake',
  // Cocktails
  'Hugo Spritz','Mango Mule','Basil Gimlet','Grapefruit Aperol Spritz','Bar Salotto Old Fashioned','Negroni','Espresso Martini','Black Manhattan','Watermelon Cooler','Smoke + Maple','Blood Orange Collins','Last Word','Boozy Slush','House Sangria',
];
// Generic food/drink nouns → the display phrase we use if a specific item wasn't named.
const GENERIC_TERMS = [
  ['pizza','pizza'],['pizzas','pizzas'],['pasta','pasta'],['meatball','meatballs'],['meatballs','meatballs'],
  ['salad','salad'],['cocktail','cocktails'],['cocktails','cocktails'],['wine','wine'],['dessert','dessert'],
  ['bolognese','Bolognese'],['vodka','Spicy Vodka'],['burrata','burrata'],['tiramisu','Tiramisu'],['gnocchi','gnocchi'],
  ['bruschetta','bruschetta'],['calamari','calamari'],['espresso martini','Espresso Martini'],['margherita','Margherita'],
];
const SERVER_CUE = /\b(server|waiter|waitress|bartender|host|hostess|took (?:great )?care|took care of us|our (?:server|waiter|bartender))\b/i;

function extractSignals(comment) {
  const text = String(comment || '');
  const low = text.toLowerCase();
  const items = [];
  for (const name of MENU_ITEMS) {
    if (low.includes(name.toLowerCase()) && !items.includes(name)) items.push(name);
  }
  if (items.length < 2) {
    for (const [term, phrase] of GENERIC_TERMS) {
      if (low.includes(term) && !items.some(i => i.toLowerCase() === phrase.toLowerCase())) { items.push(phrase); if (items.length >= 3) break; }
    }
  }
  // Staff: capitalized names appearing in a sentence that mentions a server cue.
  const staff = [];
  const reviewerCommon = new Set(['We','Our','The','This','That','It','They','Bar','Salotto','Grazie','Great','Excellent','Amazing','Best']);
  for (const sentence of text.split(/[.!?]+/)) {
    if (!SERVER_CUE.test(sentence)) continue;
    for (const m of sentence.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
      const n = m[1];
      if (!reviewerCommon.has(n) && !staff.includes(n) && staff.length < 2) staff.push(n);
    }
  }
  // Occasion
  let occasion = '';
  if (/\bbirthday\b/i.test(low)) occasion = 'birthday celebration';
  else if (/\banniversary\b/i.test(low)) occasion = 'anniversary';
  else if (/\bdate night\b/i.test(low)) occasion = 'date night';
  else if (/\b(wedding|rehearsal|engagement)\b/i.test(low)) occasion = 'special occasion';
  else if (/\b(first time|first visit)\b/i.test(low)) occasion = 'first visit';
  else if (/\b(family|kids|children)\b/i.test(low)) occasion = 'family dinner';
  return { items: items.slice(0, 3), staff, occasion };
}

function listJoin(a) {
  if (a.length <= 1) return a[0] || '';
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
}

function templateReply(first, b, sig) {
  const hi = first ? `Thank you so much, ${first}!` : 'Thank you so much!';
  const bits = [];
  if (sig.items.length) {
    bits.push(`we're thrilled the ${listJoin(sig.items)} ${sig.items.length > 1 ? 'were' : 'was'} a highlight`);
  } else if (sig.occasion) {
    bits.push(`we're so glad we could be part of your ${sig.occasion}`);
  } else {
    bits.push(`we're so glad you enjoyed your visit to Bar Salotto`);
  }
  if (sig.staff.length) {
    bits.push(`we'll be sure to pass your kind words along to ${listJoin(sig.staff)}`);
  }
  let mid = bits.join(', and ');
  mid = mid.charAt(0).toUpperCase() + mid.slice(1) + '.';
  const close = b === 'neu'
    ? `We've noted your feedback and would love the chance to make your next visit even better.`
    : `We can't wait to welcome you back!`;
  return `${hi} ${mid} ${close}`;
}

// Words that can follow a greeting comma but are NOT a person's name.
const NOT_A_NAME = new Set(['We','Your','Our','Thank','Thanks','Grazie','It','The','You','Please',
  'So','What','Hope','And','But','As','This','That','I','Ciao','Hello','Hi']);

function adaptReply(reply, pastFirst, currFirst) {
  let t = String(reply || '');

  // 1) If we know the past reviewer's display name, swap every occurrence.
  if (pastFirst) {
    const esc = pastFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (currFirst) t = t.replace(new RegExp(`\\b${esc}\\b`, 'g'), currFirst);
    else t = t.replace(new RegExp(`,?\\s*\\b${esc}\\b`, 'g'), '');
  }

  // 2) Catch a name baked into the greeting that did NOT match the display name
  //    (e.g. the past reviewer showed as "A Google user" but Phil typed a name):
  //    "...incredible review, Chrystal!"  /  "Thank you, Di, your..."
  t = swapGreetingName(t, currFirst);

  return t.replace(/\s{2,}/g, ' ').replace(/\s+([!.,?])/g, '$1').trim();
}

function swapGreetingName(text, currFirst) {
  const re = /([,]\s*)([A-Z][a-z]+)([!.,])/;
  const m = text.match(re);
  if (!m) return text;
  const name = m[2];
  if (NOT_A_NAME.has(name)) return text;        // don't touch ordinary words
  if (currFirst && name === currFirst) return text;
  if (currFirst) return text.replace(re, `$1${currFirst}$3`);
  // anonymous reviewer → drop ", Name" but keep the punctuation
  return text.replace(re, (full, pre, nm, punc) => pre.replace(/[,]\s*$/, '') + punc);
}

function carefulNegative(name, sig) {
  const n = name ? `, ${name}` : '';
  const issue = (sig && sig.items && sig.items.length)
    ? ` We're sorry the ${listJoin(sig.items)} didn't live up to what we hope to serve.`
    : '';
  return `We're so sorry to hear about your experience${n} — this isn't the standard we hold ourselves to.${issue} ` +
    `We take your feedback seriously and would genuinely like to make it right; please reach out to us at ` +
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
  const res = await gfetch(`${MB_V4}/${reviewName}/reply`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) {
    const detail = await res.text();
    const msg = res.status === 503
      ? 'Google is temporarily busy (503). We retried automatically — please try posting again in a moment.'
      : `reply_failed (${res.status})`;
    return json({ error: 'reply_failed', status: res.status, message: msg, detail }, res.status, cors);
  }
  return json({ ok: true }, 200, cors);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Google's My Business v4 API intermittently returns 503/429/5xx under load.
// Retry those a few times with exponential backoff before surfacing an error.
async function gfetch(url, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fetch(url, opts);
    if (last.status !== 503 && last.status !== 429 && last.status < 500) return last;
    if (i < tries - 1) await new Promise(r => setTimeout(r, 400 * Math.pow(2, i))); // 400,800,1600ms
  }
  return last;
}

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
