# Oura MCP Server for Claude

Let Claude read your Oura Ring data (sleep, readiness, activity, stress, workouts and heart rate) through a small private server that **you** deploy to your own free Vercel account. It is **read-only**, so it can never change anything in your Oura account.

[![CI](https://github.com/LeoRibkin/oura-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/LeoRibkin/oura-mcp-server/actions/workflows/ci.yml)
[![CodeQL](https://github.com/LeoRibkin/oura-mcp-server/actions/workflows/codeql.yml/badge.svg)](https://github.com/LeoRibkin/oura-mcp-server/actions/workflows/codeql.yml)

> [!WARNING]
> **Never share your connector URL – it is the key to your data.**
> Anyone who has it can read your Oura data. Keep it in a password manager, and never paste it into chats, emails, screenshots or GitHub issues.

## Contents

- [What it does](#what-it-does)
- [Security model](#security-model)
- [What you need](#what-you-need)
- [Setup](#setup)
- [Troubleshooting](#troubleshooting)
- [Updating safely](#updating-safely)
- [Configuration reference](#configuration-reference)
- [For developers](#for-developers)
- [License](#license)

## What it does

Once it's connected, you can ask Claude things like:

- "How did I sleep last night?"
- "Compare my readiness this week with last week."
- "Was my resting heart rate higher on days I worked out?"

### Tools

Every tool is read-only. Dates use the `YYYY-MM-DD` format and your own time zone (`TIMEZONE`). Unless you ask otherwise, a tool returns **the last 7 days, ending today**. Durations are in seconds.

| Tool | What it returns | Parameters |
|---|---|---|
| `daily_sleep` | Daily sleep score (0–100) and its contributors | `start_date`, `end_date` |
| `sleep` | Detailed sleep sessions: bedtime and wake time; total, deep, REM and light sleep; awake time, efficiency and latency; average HRV; average and lowest heart rate; breathing rate | `start_date`, `end_date`, `include_timeseries` |
| `daily_readiness` | Readiness score, temperature deviation and contributors | `start_date`, `end_date` |
| `daily_activity` | Activity score, steps, calories, distance, and time at each activity level | `start_date`, `end_date`, `include_timeseries` |
| `daily_stress` | Time in high stress and in high recovery, plus a day summary | `start_date`, `end_date` |
| `workouts` | Workouts: activity, start and end time, calories, distance, intensity, source | `start_date`, `end_date` |
| `heartrate` | Heart-rate samples, summarized automatically: raw up to 6 hours, hourly up to 3 days, daily beyond that (31 days at most) | `start_date`, `end_date`, `start_datetime`, `end_datetime`, `granularity` |
| `personal_info` | Age, weight, height, biological sex and email of the Oura account | none |

| Parameter | Type | Meaning |
|---|---|---|
| `start_date` | date, optional | First day to include. Default: 6 days before `end_date`. |
| `end_date` | date, optional | Last day to include (inclusive). Default: today. |
| `include_timeseries` | true/false, optional | `sleep`: adds 5-minute HRV and heart-rate samples and the sleep phases. `daily_activity`: adds per-minute MET values and 5-minute activity classes. Default `false`, because these are large. |
| `start_datetime`, `end_datetime` | ISO 8601 time, optional | `heartrate` only. An exact time window, for example `2026-01-15T06:00:00+01:00`. Overrides the dates. |
| `granularity` | `auto`, `raw`, `hourly` or `daily`, optional | `heartrate` only. Default `auto`. |

Sleep is filed under the day you **woke up**, so "last night" is today's date. The main night has the type `long_sleep`.

## Security model

- **Single-user and self-hosted.** You deploy your own copy to your own Vercel account. It serves exactly one Oura account: yours. Nobody else, including the authors of this repository, can reach your deployment or your data.
- **The secret URL is the key.** Claude talks to `https://<your-app>/oura/<OURA_PATH_SECRET>/mcp`. Every private page (the MCP endpoint, the setup page and the connect button) lives under that unguessable secret. Any other path, or a wrong secret, gets a plain `Not found`. There is no separate login, so anyone with the full URL can read your Oura data. If the URL ever leaks, set a new `OURA_PATH_SECRET` in Vercel and redeploy. The old URL stops working at once. Then update the URL in Claude.
- **Read-only.** The server only makes read (`GET`) requests to the Oura API v2. It asks Oura only for the scopes `email personal daily heartrate workout`. It can't change, delete or upload anything in your Oura account.
- **What data is touched.** Only what you ask for through Claude: daily sleep, sleep sessions, readiness, activity, stress, workouts, heart rate and personal info. The data goes straight to Claude and is **not stored** by the server.
- **What is stored.** Only your Oura sign-in (access and refresh tokens). Oura's refresh tokens work only once and are replaced at every renewal, so the server keeps them in a **private Vercel Blob store in your own account**. They're encrypted with AES-256-GCM, using a key derived (HKDF-SHA256) from your `OURA_CLIENT_SECRET`. Nothing else is stored.
- **What is never logged.** This code never writes tokens, client secrets, the path secret or your Oura data to logs. Error messages are logged with anything that looks like a token replaced by `[redacted]`. Note that Vercel's own request logs, visible only inside your Vercel account, show request paths, and those include your path secret. That's one more reason to protect your Vercel account with two-factor authentication and not to forward logs to services you don't trust.
- **Hardened sign-in.** Connecting your Oura account uses OAuth 2.0 with PKCE (S256), a signed `state` that expires after 15 minutes, and a `__Host-` cookie that ties the sign-in to the browser that started it. Pages are sent with `no-store`, `noindex` and a strict Content-Security-Policy.
- **What it can't protect against.** Someone who has your connector URL, or access to your Vercel or Claude account.

## What you need

- An **Oura Ring** with an active **Oura Membership**. Oura's API only shares data for members.
- A free **GitHub** account. The Deploy button copies this project into your account.
- A free **Vercel** account. The Hobby plan is enough.
- A **Claude** account that can add custom connectors (**Settings → Connectors**).
- About 20 minutes. No coding.

## Setup

### Step 1: Prepare two values

1. **Your path secret.** This is a long random password that becomes part of your private connector URL. Use **only letters and digits** (no symbols), at least 32 characters. Any of these works:
   - Your password manager's generator, with symbols turned off and a length of 40.
   - On a Mac or Linux, in Terminal: `openssl rand -hex 24`
   - On Windows, in PowerShell: `$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`

   Save it in your password manager.
2. **Your time zone**, in "Region/City" form, for example `Europe/London`, `America/New_York` or `Asia/Tokyo` ([list of time zones](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)). It decides what "today" and "last night" mean.

### Step 2: Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLeoRibkin%2Foura-mcp-server%2Ftree%2Fv1.0.0&project-name=oura-mcp-server&repository-name=oura-mcp-server&env=OURA_PATH_SECRET,TIMEZONE&envDescription=OURA_PATH_SECRET%3A%20a%20long%20random%20secret%20%28letters%20and%20digits%20only%2C%2032%2B%20characters%29%20that%20becomes%20part%20of%20your%20private%20connector%20URL.%20TIMEZONE%3A%20your%20time%20zone%2C%20for%20example%20Europe%2FLondon.&envLink=https%3A%2F%2Fgithub.com%2FLeoRibkin%2Foura-mcp-server%23step-1-prepare-two-values&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

1. Click **Deploy with Vercel** above. Sign in to Vercel (or create a free account), and connect your GitHub account if asked.
2. Under **Create Git Repository**, keep the name `oura-mcp-server`. If you see **Create private Git Repository**, leave it ticked. Vercel copies release **v1.0.0** of this project into your own GitHub account, and your deployment is built only from that copy.
3. When Vercel offers to add a **Blob** store, keep **Private** access and click **Create** (and **Connect**, if asked). This is where your encrypted Oura sign-in will live.
4. Fill in the two environment variables:
   - `OURA_PATH_SECRET`: your path secret from Step 1.
   - `TIMEZONE`: your time zone from Step 1.
5. Click **Deploy** and wait about a minute, until Vercel congratulates you.
6. Click **Continue to Dashboard**. Under **Domains**, note your address, for example `oura-mcp-server-abc123.vercel.app`. In the rest of this guide, `<your-app>` means this address.

### Step 3: Open your private setup page

Open `https://<your-app>/oura/<your path secret>/setup` and bookmark it. Keep it private, like the connector URL. The page shows a checklist, with **Copy** buttons for every value you need next. **Private storage connected** should already be green.

### Step 4: Create your Oura application

1. Go to <https://cloud.ouraring.com/oauth/applications> and sign in with your Oura account. It may send you to developer.ouraring.com, which is fine.
2. Click **New Application**. It may be called *Create* or *Register* instead.
3. Fill in the form, copying the values from your setup page:
   - **Name:** anything you like, for example `Claude Connector`
   - **Description:** `Personal connector so Claude can read my Oura data`
   - **Contact email:** your email address
   - **Website:** `https://<your-app>`
   - **Privacy policy URL:** `https://<your-app>/privacy`
   - **Terms of service URL:** `https://<your-app>/terms`
   - **Redirect URI:** `https://<your-app>/oauth/oura/callback`
   - **Scopes:** tick **email**, **personal**, **daily**, **heartrate** and **workout**.
4. Save. The application page shows a **Client ID** and a **Client Secret**. Treat the secret like a password.

### Step 5: Save the Oura keys in Vercel

1. In Vercel, open your project, then **Settings** → **Environment Variables**.
2. Add `OURA_CLIENT_ID`, with the Client ID as its value.
3. Add `OURA_CLIENT_SECRET`, with the Client Secret as its value, and turn **Sensitive** on.
4. Keep the environments **Production** and **Preview**, and click **Save**.
5. Redeploy so the server picks them up: open **Deployments**, click **⋯** next to the newest deployment, and choose **Redeploy**.

### Step 6: Check the token storage

Reload your setup page. The first three items should all be green: `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, and **Private storage connected (Vercel Blob)**.

If the storage item isn't green (for example, because you skipped the Blob store in Step 2): in Vercel, open your project, then **Storage** → **Create Database** → **Blob**. Choose **Private**, click **Create**, and connect the store to this project (Production and Preview). Then redeploy, as in Step 5.

### Step 7: Connect your Oura account

1. On the setup page, click **Connect Oura account**. Do the whole step in one browser, within 15 minutes.
2. Sign in to Oura if asked. On Oura's permission page, **leave every data type switched on** and click **Accept**.
3. You'll land on a page that says **"✓ Oura account connected"**. There's nothing to copy: the sign-in is stored encrypted in your Blob store, and it renews itself.

### Step 8: Add the connector in Claude

1. In Claude, open **Settings → Connectors** and click **Add custom connector**.
2. **Name:** `Oura Ring`. **URL:** `https://<your-app>/oura/<your path secret>/mcp`
3. Leave the advanced settings empty and click **Add**. There's no sign-in step, because the secret in the URL is what protects it.
4. In a chat, make sure the connector is switched on in the tools menu. Then ask: *"How did I sleep last night?"*

## Troubleshooting

Start with your setup page: every red item says what's wrong and how to fix it.

| Problem | What to do |
|---|---|
| **Last night's sleep or today's readiness is missing** | Oura only has the data after your ring syncs. Open the Oura app on your phone, wait until it has synced and processed the night, then ask again. |
| **Error 401, or "Oura rejected the saved sign-in"** | Your Oura sign-in was revoked or has expired. Open the setup page and click **Reconnect Oura account**. |
| **Error 403, or "Oura refused access"** | Either your Oura Membership isn't active, or a data type was switched off when you connected. Check your membership, then reconnect and leave every data type on. |
| **"The saved Oura sign-in can't be read"** | `OURA_CLIENT_SECRET` has changed since you connected. Click **Reconnect Oura account**. |
| **"The Oura connector has no storage connected"** | Connect a private Blob store (Step 6), then redeploy. |
| **Oura says the redirect URI is invalid** | The redirect URI in your Oura application must exactly match the one on your setup page: `https://<your-app>/oauth/oura/callback`. |
| **"Link expired" after signing in** | Start again from the setup page, in the same browser, and finish within 15 minutes. |
| **The setup page or connector URL says `Not found`** | The secret in the URL must exactly match `OURA_PATH_SECRET`. Open `https://<your-app>/`: it tells you if the secret is missing or unusable. Redeploy after changing any environment variable. |
| **Days are shifted by one** | Set `TIMEZONE` to your time zone (Step 1), then redeploy. |
| **"Oura rate limit reached" (error 429)** | Wait a few minutes and try again. |
| **Claude can't connect** | Use your production address (`https://<your-app>`), not the address of a single deployment, and check that the URL ends in `/mcp`. In Vercel, check that the newest deployment is **Ready**. |

## Updating safely

**Your deployment never updates itself.** The Deploy button copied one specific release into your own GitHub account, and Vercel builds only from that copy. Nothing pushed to this repository later can reach your deployment unless you choose to bring it in.

When a new version appears on the [Releases page](https://github.com/LeoRibkin/oura-mcp-server/releases):

1. Read its release notes and [CHANGELOG.md](CHANGELOG.md).
2. Review exactly what changed: `https://github.com/LeoRibkin/oura-mcp-server/compare/<your version>...<new version>` (for example `.../compare/v1.0.0...v1.1.0`).
3. Only if you're happy with it, update your copy:
   - **Without coding:** download the release's **Source code (zip)** and unzip it. In your copy on GitHub, use **Add file → Upload files** to upload all the files, then commit. Vercel redeploys automatically from your copy.
   - **With git:** in your copy, run `git fetch https://github.com/LeoRibkin/oura-mcp-server.git tag <new version>`, then `git checkout <new version> -- .`, then commit.
4. Open your setup page and check that everything is still green.

Rules of thumb:

- Deploy a **release tag** (like `v1.0.0`) or the **full commit SHA** shown on that release, never the moving `main` branch.
- **Don't** connect your Vercel project directly to this repository, and don't turn on automatic fork syncing. Either one would let any future push, including a malicious one, deploy to you automatically.
- If your own tools pin a commit SHA, check that what was checked out really is that commit (`git rev-parse HEAD`).

**Why this matters.** The [Plugin4Shell](https://www.air.security/blog-posts/plugin4shell) research showed how a trusted plugin repository can turn malicious after it has earned users' trust, and how background auto-updates then deliver the new code to every user without anyone clicking anything. That even happened to "pinned" versions, in tools that never checked what they had actually downloaded. A pinned, reviewed version protects you even if this repository is ever compromised. A compromised repository can't change the code you're already running, releases here are immutable (their tags can't be moved to different code), and you see every change before it reaches your data.

## Configuration reference

| Variable | Required | What it is |
|---|---|---|
| `OURA_PATH_SECRET` | yes | Long random string: letters, digits, `-` and `_` only; at least 16 characters, 32 or more recommended. Part of every private URL. |
| `TIMEZONE` | yes | Your IANA time zone, for example `Europe/London`. If it's unset or invalid, `UTC` is used. |
| `OURA_CLIENT_ID` | yes | From your Oura application. |
| `OURA_CLIENT_SECRET` | yes | From your Oura application. Also used to derive the token-encryption key. Mark it **Sensitive** in Vercel. |
| `BLOB_READ_WRITE_TOKEN` | yes (automatic) | Added by Vercel when you connect a private Blob store. |
| `PUBLIC_BASE_URL` | no | Only for a custom domain, for example `https://oura.example.com`. Defaults to your project's production address. |
| `OURA_SCOPES` | no | Replaces the requested Oura scopes. Default: `email personal daily heartrate workout`. |

All configuration comes from environment variables; see [.env.example](.env.example). Nothing is hard-coded.

## For developers

- Node.js 22 with ES modules, and no build step. One Vercel function (`api/index.js`) serves everything: `lib/app.js` routes requests, `lib/oura.js` holds the Oura client, MCP tools and setup pages, and `lib/mcp.js` runs a stateless MCP Streamable HTTP endpoint (JSON responses, POST only).
- Run `npm ci`, `npm run lint` and `npm test`. The tests use Node's built-in test runner, a simulated Oura API and an in-memory token store, with no network access or real accounts.
- Dependencies are pinned to exact versions with a committed `package-lock.json`, and `.npmrc` turns off dependency install scripts.
- Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). This project is not affiliated with or endorsed by Oura, Vercel or Anthropic. Oura is a trademark of Oura Health Oy.
