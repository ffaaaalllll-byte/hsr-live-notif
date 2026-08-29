// check.js
// Checks whether a YouTube channel is currently live, and posts a Discord
// webhook notification the moment a new livestream starts. Designed to be
// run on a schedule (see .github/workflows/check-live.yml) rather than as a
// long-running process.

const fs = require('fs');
const path = require('path');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_USER_ID = process.env.DISCORD_USER_ID; // optional: pings you directly

const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastNotifiedVideoId: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function getLiveVideo() {
  const url =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&channelId=${CHANNEL_ID}&eventType=live&type=video` +
    `&key=${YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }
  const data = await res.json();

  if (data.items && data.items.length > 0) {
    const item = data.items[0];
    return {
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
    };
  }
  return null;
}

async function notifyDiscord(video) {
  const mention = DISCORD_USER_ID ? `<@${DISCORD_USER_ID}> ` : '';
  const content =
    `${mention}\u{1F534} **${video.channelTitle}** is LIVE now!\n` +
    `**${video.title}**\n` +
    `https://www.youtube.com/watch?v=${video.videoId}`;

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook error ${res.status}: ${text}`);
  }
}

async function main() {
  const missing = ['YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'DISCORD_WEBHOOK_URL']
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const state = loadState();
  const live = await getLiveVideo();

  if (live) {
    if (state.lastNotifiedVideoId !== live.videoId) {
      console.log(`Channel is live: "${live.title}" (${live.videoId}). Notifying Discord.`);
      await notifyDiscord(live);
      state.lastNotifiedVideoId = live.videoId;
      saveState(state);
    } else {
      console.log('Channel is live, but a notification was already sent for this stream.');
    }
  } else if (state.lastNotifiedVideoId !== null) {
    console.log('Stream has ended. Resetting state so the next stream triggers a fresh alert.');
    state.lastNotifiedVideoId = null;
    saveState(state);
  } else {
    console.log('Channel is not currently live.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
