# Honkai: Star Rail Live Notifier (Discord)

Checks every 15 minutes whether the official Honkai: Star Rail YouTube
channel is live, and posts a message to a Discord webhook the moment a
stream starts. Runs entirely on GitHub Actions' free scheduler — no server,
no hosting, nothing to keep running on your own machine.

## How it works

- A GitHub Actions workflow (`.github/workflows/check-live.yml`) runs
  `check.js` every 15 minutes.
- `check.js` asks the YouTube Data API "is this channel live right now?"
- If yes, and it hasn't already notified for *this* stream, it posts to your
  Discord webhook and remembers the video ID in `state.json` so it won't spam
  you every 15 minutes for the same stream.
- When the stream ends, `state.json` resets automatically so the next one
  triggers a fresh alert.

## Setup

### 1. Create the repo

Create a **public** GitHub repo and push these files to it. Public repos get
unlimited free GitHub Actions minutes; a private repo would likely exceed
the 2,000 free minutes/month at this check frequency. Your API keys stay
safe either way — they're stored as encrypted Secrets, never in the code.

### 2. Get a YouTube Data API key (free)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or use an existing one).
3. Go to **APIs & Services > Library**, search for **YouTube Data API v3**,
   and enable it.
4. Go to **APIs & Services > Credentials > Create Credentials > API key**.
   Copy the key.

The free quota is 10,000 units/day; each check costs 100 units, so checking
every 15 minutes (96 times/day) comfortably fits.

### 3. Get the channel ID

The main Honkai: Star Rail channel ID is:

```
UC2PeMPA8PAOp-bynLoCeMLA
```

(This is `youtube.com/@HonkaiStarRail`.) If you want a different regional
channel (JP/KR/CN etc.), open that channel's page, view page source, and
search for `"channelId"` — or use any "YouTube channel ID finder" site.

### 4. Create a Discord webhook

1. In Discord, go to the server/channel where you want alerts (you can
   create a private server just for yourself in a few seconds if you don't
   have one).
2. Right-click the channel → **Edit Channel** → **Integrations** →
   **Webhooks** → **New Webhook**.
3. Copy the **Webhook URL**.

### 5. (Optional) Get your Discord user ID, to get pinged directly

1. Discord **Settings → Advanced → Developer Mode** (turn it on).
2. Right-click your own username anywhere → **Copy User ID**.

### 6. Add secrets to your GitHub repo

In your repo: **Settings → Secrets and variables → Actions → New repository
secret**. Add:

| Secret name | Value |
|---|---|
| `YOUTUBE_API_KEY` | the API key from step 2 |
| `YOUTUBE_CHANNEL_ID` | `UC2PeMPA8PAOp-bynLoCeMLA` (or your chosen channel) |
| `DISCORD_WEBHOOK_URL` | the webhook URL from step 4 |
| `DISCORD_USER_ID` | (optional) your user ID from step 5 |

### 7. Test it

Go to the **Actions** tab in your repo → **Check Honkai Star Rail Live
Status** → **Run workflow**. Check the run's logs to confirm it worked, and
check Discord if the channel happens to be live.

From then on it runs automatically every 15 minutes.

## Notes

- GitHub disables scheduled workflows automatically after 60 days with no
  repo activity — just visit the repo occasionally, or make any small commit,
  to keep it active.
- If you'd rather not make the repo public, you can still use a private
  repo — just change the cron to every 30 minutes
  (`*/30 * * * *`) to comfortably stay within the free private-repo minutes.
