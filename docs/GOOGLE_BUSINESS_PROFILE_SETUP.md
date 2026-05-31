# Google Business Profile — Reviews Setup

This connects the dashboard to your Google reviews so it can **pull unanswered
reviews** and **post approved replies** automatically.

There are two clocks running here. **Start Step 1 today** — Google's review of
your API access request is the slow part (often several business days).

---

## Step 1 — Request API access (do this first; it's the long pole)

1. Go to **https://console.cloud.google.com** and create a new project
   (e.g. "Bar Salotto Responders"). Use the Google account that **owns/manages**
   the Bar Salotto Google Business Profile.
2. Enable these APIs (APIs & Services → Library → search → Enable):
   - **Google My Business API** (`mybusiness.googleapis.com`) — reviews live here
   - **My Business Account Management API**
   - **My Business Business Information API**
3. Submit the **Business Profile API access request form**:
   **https://support.google.com/business/contact/api_default**
   - Fill in the Google Cloud **Project ID** from Step 1.
   - Use case: "Reading and replying to our own restaurant's customer reviews."
   - Google emails you when it's approved. **This can take several days.**

> Until this is approved, the API calls return permission errors and the
> dashboard simply shows the "not connected yet" screen. That's expected.

---

## Step 2 — Create OAuth credentials

1. In Cloud Console → **APIs & Services → OAuth consent screen**:
   - User type: **External**, app name "Bar Salotto", your email as support +
     developer contact. Add yourself as a **Test user**.
   - Add scope: `https://www.googleapis.com/auth/business.manage`
2. → **Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`
   - Save the **Client ID** and **Client secret**.

---

## Step 3 — Get a refresh token

1. Go to **https://developers.google.com/oauthplayground**
2. Click the ⚙️ gear (top right) → check **"Use your own OAuth credentials"** →
   paste your Client ID + Client secret.
3. In the left "Input your own scopes" box, enter:
   `https://www.googleapis.com/auth/business.manage`
   → **Authorize APIs** → sign in with the business-owner Google account → Allow.
4. Click **Exchange authorization code for tokens**.
5. Copy the **Refresh token** (a long string starting with `1//`).

---

## Step 4 — Store credentials in Cloudflare KV

1. Create the KV namespace (one time):
   ```bash
   npx wrangler kv namespace create BS_KV
   ```
   Copy the printed **id**.

2. In the Cloudflare dashboard → your Pages project **barsalottoautoresponders**
   → **Settings → Functions → KV namespace bindings** → **Add binding**:
   - Variable name: `BS_KV`
   - KV namespace: select the one you just created
   - Save. (Pages reads KV bindings from the dashboard, not `wrangler.toml`.)

3. Save the credentials JSON into KV:
   ```bash
   npx wrangler kv key put --namespace-id=<THE_ID_FROM_STEP_1> \
     "bs:gbp:credentials" \
     '{"client_id":"...","client_secret":"...","refresh_token":"1//..."}'
   ```

4. Redeploy (any push to `main`, or Cloudflare → Deployments → Retry latest).

---

## Step 5 — Verify

Open **https://barsalottoautoresponders.pages.dev/dashboard/reviews.html**

- If connected: your reviews load. "Needs Reply" lists unanswered ones, each
  with a suggested draft (warm, specific, **no sign-off** — per
  `brand/review-voice.md`). Edit, then **Post Reply to Google**.
- If you still see "not connected yet": the API access request (Step 1) likely
  isn't approved yet, or the credentials/binding aren't saved.

---

## Notes
- The same `BS_KV` namespace also holds the Gmail credentials
  (`bs:gmail:credentials`) for the inbox dashboard — one namespace, two keys.
- The account/location is auto-discovered and cached for 24h under
  `bs:gbp:location`. If you ever switch locations, delete that key.
- Reviews remain on the legacy **My Business v4** endpoint; that's intentional,
  not a bug — Google never migrated reviews to the v1 APIs.
