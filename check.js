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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // optional
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // optional

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

// Every channel has an "uploads" playlist whose ID is derived by swapping
// the "UC" prefix of the channel ID for "UU" - a well-known YouTube
// convention. This lets us skip an extra API call just to look it up.
function getUploadsPlaylistId(channelId) {
  return channelId.replace(/^UC/, 'UU');
}

// We previously tried YouTube's public RSS feed here (0 quota cost), but
// that endpoint has become unreliable - it's been widely reported to
// intermittently 404 even for valid, active channels. playlistItems.list is
// an official, stable API endpoint that costs only 1 quota unit per call,
// so we use that instead: still ~100x cheaper than the original search.list
// approach (100 units), but without relying on a flaky free endpoint.
async function getRecentVideoIds() {
  const playlistId = getUploadsPlaylistId(CHANNEL_ID);
  const url =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=contentDetails&playlistId=${playlistId}&maxResults=3&key=${YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return (data.items || []).map((item) => item.contentDetails.videoId);
}

async function getLiveVideo() {
  const candidates = await getRecentVideoIds();
  if (candidates.length === 0) return null;

  const url =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=snippet&id=${candidates.join(',')}&key=${YOUTUBE_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }
  const data = await res.json();

  const liveItem = (data.items || []).find(
    (item) => item.snippet.liveBroadcastContent === 'live'
  );

  if (liveItem) {
    return {
      videoId: liveItem.id,
      title: liveItem.snippet.title,
      channelTitle: liveItem.snippet.channelTitle,
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

// Sends a message via Telegram. Does nothing if Telegram isn't configured,
// so it's entirely optional on top of Discord.
async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${errText}`);
  }
}

// Sends the "channel is live" alert to every configured platform. Discord
// failures are treated as real errors (it's the required channel); Telegram
// failures are only logged, since it's optional.
async function notifyLive(video) {
  await notifyDiscord(video);
  try {
    await notifyTelegram(
      `\u{1F534} *${video.channelTitle}* is LIVE now!\n` +
        `*${video.title}*\n` +
        `https://www.youtube.com/watch?v=${video.videoId}`
    );
  } catch (err) {
    console.warn(`Telegram notification failed: ${err.message}`);
  }
}

// Pages that compile current Honkai: Star Rail redemption codes as plain
// text (usually updated within minutes of a livestream). You can add more
// URLs to this array for redundancy if you find other reliable sources.
const CODE_TRACKER_URLS = ['https://www.pockettactics.com/honkai-star-rail/codes'];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"');
}

// Looks for lines shaped like "CODE - reward description", which is how
// these tracker pages format each redemption code. This is a best-effort
// heuristic tied to how the page currently looks; if the site changes its
// layout, this will simply find 0 codes rather than error out.
function extractCodesFromText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const found = new Map();

  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9]{3,19})\s*[-\u2013]\s*(.{5,150})$/);
    if (match) {
      const [, code, reward] = match;
      if (/stellar jade|credit|traveler|aether|guide|fuel/i.test(reward)) {
        found.set(code, reward.trim());
      }
    }
  }
  return [...found.entries()].map(([code, reward]) => ({ code, reward }));
}

async function findCurrentCodes() {
  const all = new Map();
  for (const url of CODE_TRACKER_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HSR-Live-Notifier/1.0)' },
      });
      if (!res.ok) {
        console.warn(`Could not fetch ${url}: ${res.status}`);
        continue;
      }
      const html = await res.text();
      const entries = extractCodesFromText(stripHtml(html));
      entries.forEach(({ code, reward }) => all.set(code, reward));
    } catch (err) {
      console.warn(`Error checking ${url}: ${err.message}`);
    }
  }
  return [...all.entries()].map(([code, reward]) => ({ code, reward }));
}

async function notifyDiscordCode(entry) {
  const mention = DISCORD_USER_ID ? `<@${DISCORD_USER_ID}> ` : '';
  const content =
    `${mention}\u{1F381} New Honkai: Star Rail code: **${entry.code}**\n` +
    `Reward: ${entry.reward}\n` +
    `Redeem: https://hsr.hoyoverse.com/gift?code=${entry.code}`;

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

async function notifyCode(entry) {
  await notifyDiscordCode(entry);
  try {
    await notifyTelegram(
      `\u{1F381} New Honkai: Star Rail code: *${entry.code}*\n` +
        `Reward: ${entry.reward}\n` +
        `Redeem: https://hsr.hoyoverse.com/gift?code=${entry.code}`
    );
  } catch (err) {
    console.warn(`Telegram notification failed: ${err.message}`);
  }
}

async function checkForNewCodes(state) {
  const current = await findCurrentCodes();

  if (current.length === 0) {
    console.log('Code tracker: no codes matched on the page right now.');
    return;
  }

  const known = state.knownCodes || [];

  // First time this has ever run: record everything already on the page as
  // "known" without notifying, so you don't get flooded with old codes.
  if (!state.codesSeeded) {
    console.log(`Seeding known code list with ${current.length} existing code(s). No notifications sent for these.`);
    state.knownCodes = current.map((c) => c.code);
    state.codesSeeded = true;
    saveState(state);
    return;
  }

  const knownSet = new Set(known);
  const newEntries = current.filter((c) => !knownSet.has(c.code));

  if (newEntries.length > 0) {
    console.log(`Found ${newEntries.length} new code(s): ${newEntries.map((e) => e.code).join(', ')}`);
    for (const entry of newEntries) {
      await notifyCode(entry);
    }
    state.knownCodes = [...knownSet, ...newEntries.map((e) => e.code)];
    saveState(state);
  } else {
    console.log('No new redemption codes found.');
  }
}

async function main() {
  // Test mode: send a sample notification straight to Discord so you can see
  // exactly what it looks like, without waiting for a real stream or needing
  // YouTube credentials at all. Triggered via the "Send test notification"
  // checkbox when manually running the workflow.
  if (process.env.TEST_NOTIFICATION === 'true') {
    if (!process.env.DISCORD_WEBHOOK_URL) {
      throw new Error('Missing required environment variable: DISCORD_WEBHOOK_URL');
    }
    console.log('TEST_NOTIFICATION is set. Sending a sample message (real live-check is skipped, state.json is untouched).');
    await notifyLive({
      videoId: 'dQw4w9WgXcQ',
      title: '[TEST] Sample Special Program Title',
      channelTitle: 'Honkai: Star Rail',
    });
    console.log('Test notification sent.');
    return;
  }

  const missing = ['YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'DISCORD_WEBHOOK_URL']
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const state = loadState();
  const live = await getLiveVideo();

  if (live) {
    if (state.lastNotifiedVideoId !== live.videoId) {
      console.log(`Channel is live: "${live.title}" (${live.videoId}). Sending notifications.`);
      await notifyLive(live);
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

  try {
    await checkForNewCodes(state);
  } catch (err) {
    // Don't let a code-tracker hiccup fail the whole run (the live-check
    // above already succeeded and matters more).
    console.warn(`Code check failed this round: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
