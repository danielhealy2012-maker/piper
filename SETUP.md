# Setup

Piper runs in two modes. **Demo mode** needs no accounts and works offline-ish;
**multiplayer mode** adds real sign-in and real-time chat between two people.

---

## 1. Demo mode (what runs today)

```
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env    # optional — the app works without it
npm run proxy   # terminal 1 — http://localhost:8787, holds the API key
npm run dev     # terminal 2 — http://localhost:5173
```

Open http://localhost:5173. Two fake participants, messages live in the tab only.
Health check: http://localhost:5173/api/health

---

## 2. Multiplayer mode (real accounts, real-time, two people over the web)

### a. Create the Supabase project

1. Go to https://supabase.com → **New project** (free tier is fine). Pick a region near you.
2. Wait for it to finish provisioning (~1 min).

### b. Create the schema

1. In the Supabase dashboard open **SQL Editor → New query**.
2. Paste the entire contents of `supabase/migrations/0001_init.sql` and **Run**.
   This creates the tables, the row-level-security policies (which is what makes
   "my appearance changes are private to me" true at the database), and enables
   Realtime on the shared tables.

### c. Get the keys

**Project Settings → API**, then copy into `.env`:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

The anon key is safe in the browser — every table is protected by RLS.
Restart `npm run dev`; the app switches from demo mode to multiplayer automatically.

### d. Email sign-in

Supabase sends magic links out of the box on the free tier (rate-limited).
**Authentication → URL Configuration**: set **Site URL** to `http://localhost:5173`
for local testing, and add your deployed URL later.

### e. Test it with two people

1. Sign in with your email.
2. Click **Copy invite link** and send it to your friend (or open it in a private window
   with a second email address).
3. They sign in → they land in the same conversation.

Expected: messages appear live for both; **your theme changes do not change their view**;
reactions and polls DO appear for both; neither of you can edit the other's messages.

---

## 3. Deploy to the web (Vercel)

```
npm i -g vercel
vercel            # first run links the project
vercel --prod
```

Set these in **Vercel → Project → Settings → Environment Variables**:

| Variable | Value | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | your project URL | browser-safe |
| `VITE_SUPABASE_ANON_KEY` | anon key | browser-safe (RLS protects data) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | **server only** |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key | **server only** — never prefix with `VITE_` |
| `SUPABASE_URL` | your project URL | server only |

Then in Supabase **Authentication → URL Configuration**, add your Vercel URL as the
Site URL / redirect URL so magic links come back to the deployed app.

The `/api/*` routes become Vercel serverless functions automatically (`api/*.js`).
They verify the caller's Supabase session and meter usage per user, so the public
deployment can't be used as a free proxy to your Anthropic key.

Note: `git` needs Xcode command line tools on this machine (`xcode-select --install`)
if you want to deploy from a Git repo rather than the CLI directly.
