# Bar Salotto — Customer Response Automation

Entry point for any Claude Code session on this project. Read this first.

> **This project is completely independent of any other.** It has its own repo,
> its own Cloudflare Pages project, and its own Gmail/Google connections. Do not
> merge it with, or borrow infrastructure from, any other project.

---

## What it is

A customer-response automation system for **Bar Salotto** (a family-owned Italian
restaurant). It:

- reads incoming email to **ciao@barsalotto.com** and drafts on-brand replies for
  Phil to approve / edit / deny,
- manages **Google review** replies (read unanswered, draft, post),
- researches **creator/influencer** outreach and builds profile cards,
- presents everything in a **dashboard** web app (installable as a PWA).

**Owner / manager:** Phil Aiello — ciao@barsalotto.com

---

## URLs & infrastructure

- **Production dashboard:** https://barsalottoautoresponders.pages.dev/dashboard/
- **Reviews page:** https://barsalottoautoresponders.pages.dev/dashboard/reviews.html
- **GitHub:** `philaiellomarketing/BarSalottoAutoResponders`
- **Cloudflare Pages:** project `bar-salotto`, auto-deploys on every push to `main`
  (~60s). Static site, **no build step**.

### Cloudflare KV — `BS_KV` (status: not yet created)
Holds OAuth credentials for the Pages Functions. Two keys planned:
- `bs:gmail:credentials` → `{client_id, client_secret, refresh_token}` (Gmail API)
- `bs:gbp:credentials`   → `{client_id, client_secret, refresh_token}` (Google Business Profile)

Pages reads KV bindings from the **Cloudflare dashboard** (Settings → Functions →
KV namespace bindings), **NOT** `wrangler.toml`. Putting a KV id/placeholder in
`wrangler.toml` breaks the deploy (error 8000022) — keep it out.

### Connections used in Claude sessions
- **Gmail connector → ciao@barsalotto.com** (account-level). Lets a session
  `search_threads`, `get_thread`, `create_draft`, `label_thread` directly — this is
  how the email backlog gets drafted today, no OAuth setup required.
- The standalone Pages Functions (below) are for the deployed dashboard to work on
  its own, independent of a Claude session.

---

## Repo structure

```
.
├── CLAUDE.md                  ← this file
├── index.html                 ← landing redirect → /dashboard/
├── wrangler.toml              ← name="bar-salotto", pages_build_output_dir="."  (NO kv block)
├── dashboard/
│   ├── index.html             ← inbox manager UI (approve/edit/deny + Gmail quick actions)
│   ├── reviews.html           ← Google reviews UI (draft + post; manual-entry fallback)
│   └── manifest.json          ← PWA manifest (Add to Home Screen / desktop)
├── functions/api/
│   ├── gmail/index.js         ← Gmail REST: create_draft, archive, trash, flag
│   └── reviews/index.js       ← Google Business Profile: list + reply
├── brand/
│   ├── brand-guide.md         ← voice, email categories, key links, staff
│   ├── templates.md           ← official reply templates (jobs, events, catering, solicitations)
│   └── review-voice.md        ← Google review reply rules (NO sign-off is the hard rule)
├── creators/
│   ├── _template.md           ← blank creator profile
│   └── *.md                   ← one card per creator who reaches out
└── docs/
    └── GOOGLE_BUSINESS_PROFILE_SETUP.md  ← how to get GBP API access + credentials
```

---

## Brand voice (read brand/ for the full rules)

- Warm, family-owned, concise (2–4 sentences). "Ciao [Name]" formal / "Hi [Name] —" casual.
- **Email replies** are signed by Phil. **Google review replies have NO sign-off** —
  no "Phil," no "— The Bar Salotto Team." This is the single most important review rule.
- Reference something specific the person mentioned so replies never read as canned.

### Routing rules baked into the templates
- **Private events** → handled entirely through the **Toast POS**, not email; point
  people to barsalotto.com/events. There is a deposit/contract.
- **Catering** → barsalotto.com/order-catering; **up to 24 hours** lead time before pickup.
- **Staff:** Phil (Manager) · Debbie (Events, events@barsalotto.com) ·
  Thomas / Emily (thomas@barsalotto.com).
- **Yelp:** replying to a Yelp notification email from a `reply+…@messaging.yelp.com`
  address posts as the owner response on Yelp.

---

## Deploy workflow

```bash
# 1. Make the change
# 2. If you touched dashboard CSS/JS, bump any ?v= cache-bust in the HTML
# 3. Sanity check any JS:
node --check functions/api/gmail/index.js
node --check functions/api/reviews/index.js
# 4. Commit & push — Cloudflare auto-deploys main:
git add -A && git commit -m "describe change" && git push origin main
```

No `wrangler` auth is needed for normal work — pushing to `main` is the deploy.
A manual `wrangler pages deploy . --project-name=bar-salotto` is the fallback only.

---

## Current status & open follow-ups

- **Gmail drafting** works today via the ciao@ connector (draft → Phil approves in Gmail).
- **Reviews dashboard** works in **manual-entry mode** now; live Google data is gated on
  the **GBP API access request** (submit at support.google.com/business/contact/api_default —
  Google takes several days). Setup steps are in `docs/` and embedded in the reviews page popup.
- **BS_KV** namespace still needs creating + binding, plus the two credential keys, before
  the standalone Pages Functions (Gmail + reviews) can run without a Claude session.
- Reviews polling: decided **no background poller** — the dashboard fetches live on open
  plus a 10-min auto-refresh while open. Revisit only if alerts are wanted later.

---

## Gotchas

1. **No KV block in `wrangler.toml`** — bind KV in the Cloudflare dashboard instead.
2. **`[hidden]` CSS specificity** — an element with an explicit `display:` needs an
   explicit `.foo[hidden]{display:none}` guard.
3. **Review replies: never sign off.** Re-read `brand/review-voice.md` before drafting.
4. **Keep this project separate** from any other (see top of file).
