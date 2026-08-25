import { db } from "./db";
import { notifyMissedDeals } from "./notify";

// ── Types ────────────────────────────────────────────────────────────────────

interface DetectedDeal {
  label: string;
  code: string | null;
  context: string;
  url: string | null;
  expiresAt: string | null;
  expiryText: string | null;
}

export interface ChannelSearchResult {
  id: string;
  name: string;
  subscribers: string;
  thumbnail: string;
}

export interface ScannedVideo {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  deals: DetectedDeal[];
}

// ── Channel search (works from cloud — no IP block) ──────────────────────────

export async function searchChannels(query: string): Promise<ChannelSearchResult[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253D%253D`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const html = await res.text();

  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];

  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }

  const results: ChannelSearchResult[] = [];
  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];

  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents ?? [];
    for (const item of items) {
      const ch = item?.channelRenderer;
      if (!ch) continue;
      const id = ch.channelId;
      const name = ch.title?.simpleText ?? "";
      const subscribers =
        ch.videoCountText?.simpleText ?? ch.subscriberCountText?.simpleText ?? "";
      const thumbs = ch.thumbnail?.thumbnails ?? [];
      let thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : "";
      if (thumbnail.startsWith("//")) thumbnail = "https:" + thumbnail;
      if (id && name) results.push({ id, name, subscribers, thumbnail });
      if (results.length >= 6) break;
    }
    if (results.length >= 6) break;
  }

  return results;
}

// ── Promo detection (from video descriptions via RSS) ────────────────────────

const PROMO_RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /use\s+(?:code|coupon|promo\s*code)\s+["']?([A-Z0-9][A-Z0-9_\-]{2,19})["']?/gi, label: "Promo code" },
  { pattern: /(?:discount|promo|coupon)\s+code[:\s]+["']?([A-Z0-9][A-Z0-9_\-]{2,19})["']?/gi, label: "Discount code" },
  { pattern: /code\s+["']?([A-Z0-9][A-Z0-9_\-]{2,19})["']?\s+(?:for|to\s+(?:get|save))/gi, label: "Promo code" },
  { pattern: /(?:get|save)\s+(?:up\s+to\s+)?(\d+%|\$\d+)\s+off/gi, label: "Discount" },
  { pattern: /(\d+%)\s+(?:off|discount)/gi, label: "Discount" },
  { pattern: /free\s+trial\b/gi, label: "Free trial" },
  { pattern: /\d+\s*(?:month|day|week)s?\s+free\b/gi, label: "Free trial" },
  { pattern: /giveaway\b/gi, label: "Giveaway" },
  { pattern: /limited\s+time\s+(?:offer|deal)\b/gi, label: "Limited offer" },
  { pattern: /exclusive\s+(?:deal|discount|offer)\b/gi, label: "Exclusive deal" },
  // Plain sponsor mentions carry no code/discount language at all — the most
  // common real-world sponsor read ("thanks to X for sponsoring, check them
  // out at [link]"). Only counts as a deal if a nearby link resolves (below).
  {
    pattern: /\b(?:thanks?\s+(?:to\s+)?[A-Za-z][\w.&' -]{0,40}?\s+for\s+sponsoring|sponsored\s+by|in\s+partnership\s+with|paid\s+partnership(?:\s+with)?|brought\s+to\s+you\s+by)\b/gi,
    label: "Sponsor",
  },
];

// Sponsor/affiliate URLs that usually carry the deal (e.g. ridge.com/MKBHD)
const DEAL_URL_RE = /https?:\/\/(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})((?:\/[A-Za-z0-9_\-]+)+)?/gi;
const GENERIC_DOMAINS = new Set([
  "youtube.com", "youtu.be", "twitter.com", "x.com", "instagram.com", "facebook.com",
  "tiktok.com", "discord.gg", "discord.com", "patreon.com", "twitch.tv", "goo.gl",
  "bit.ly", "linktr.ee", "spotify.com", "apple.com", "threads.net", "reddit.com",
]);

// Find the sponsor link closest to a specific point in the description, so a
// deal gets paired with its own URL instead of the first sponsor link overall.
function findDealUrl(description: string, nearIndex?: number): string | null {
  const matches = [...description.matchAll(DEAL_URL_RE)].filter((m) => {
    // Compare against the base domain so subdomains (e.g. m.youtube.com) are caught.
    const baseDomain = m[1].toLowerCase().split(".").slice(-2).join(".");
    const path = m[2];
    // a sponsor link usually has a path segment (the creator's code) and isn't a social domain
    return !GENERIC_DOMAINS.has(baseDomain) && path && path.length > 1;
  });
  if (matches.length === 0) return null;
  if (nearIndex === undefined) return matches[0][0];

  // A link on the same line as the deal text is almost always its link.
  const lineStart = description.lastIndexOf("\n", nearIndex) + 1;
  let lineEnd = description.indexOf("\n", nearIndex);
  if (lineEnd === -1) lineEnd = description.length;
  const sameLine = matches.find((m) => (m.index ?? 0) >= lineStart && (m.index ?? 0) < lineEnd);
  if (sameLine) return sameLine[0];

  // Otherwise fall back to the closest link within the same paragraph.
  let best = matches[0];
  let bestDist = Infinity;
  for (const m of matches) {
    const dist = Math.abs((m.index ?? 0) - nearIndex);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return bestDist <= 300 ? best[0] : null;
}

// Many channels list their ongoing affiliate deals under a "Channel
// Partners"/"Our Sponsors" header as one "Name - blurb: link" line each, with
// no per-line "sponsor" keyword to match on — so PROMO_RULES misses them
// entirely. Parse that block directly instead.
const PARTNER_HEADER_RE = /(?:channel\s+partners|our\s+sponsors)\s*:?\s*\n/i;
const PARTNER_LINE_RE = /^\s*([A-Za-z][\w&'".\- ]{0,30}?)\s*[-–:]\s*.*?(https?:\/\/\S+?)[).,]*\s*$/;

function findPartnerListDeals(description: string): DetectedDeal[] {
  const header = description.match(PARTNER_HEADER_RE);
  if (!header) return [];

  const start = (header.index ?? 0) + header[0].length;
  const end = description.indexOf("\n\n", start);
  const block = description.slice(start, end === -1 ? description.length : end);

  const deals: DetectedDeal[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(PARTNER_LINE_RE);
    if (!m) continue;
    const baseDomain = m[2]
      .replace(/^https?:\/\/(?:www\.)?/i, "")
      .split(/[\/?#]/)[0]
      .split(".")
      .slice(-2)
      .join(".")
      .toLowerCase();
    if (GENERIC_DOMAINS.has(baseDomain)) continue;

    deals.push({
      label: "Sponsor",
      code: null,
      context: line.trim().replace(/\s+/g, " ").slice(0, 200),
      url: m[2],
      expiresAt: null,
      expiryText: null,
    });
  }
  return deals;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Phrases that signal an expiry is nearby
const EXPIRY_TRIGGER = /(?:ends?|expires?|expiring|valid\s+(?:un)?til|through|offer\s+ends?|deal\s+ends?|good\s+(?:un)?til|until|before|by)\b/i;

function parseExpiry(description: string): { iso: string; text: string } | null {
  // Only look near an expiry trigger word to avoid matching random dates
  const trigger = description.match(EXPIRY_TRIGGER);
  if (!trigger) return null;
  const idx = trigger.index ?? 0;
  const window = description.slice(idx, Math.min(description.length, idx + 80));

  const now = new Date();
  const year = now.getUTCFullYear();

  // "June 21st", "June 21", "Jun 21 2026"
  const monthDay = window.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i,
  );
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase().replace(".", "")];
    const day = parseInt(monthDay[2], 10);
    let yr = monthDay[3] ? parseInt(monthDay[3], 10) : year;
    if (month !== undefined && day >= 1 && day <= 31) {
      let d = new Date(Date.UTC(yr, month, day, 23, 59, 59));
      // If no explicit year and the date is well in the past, assume next year
      if (!monthDay[3] && d.getTime() < now.getTime() - 7 * 864e5) {
        d = new Date(Date.UTC(yr + 1, month, day, 23, 59, 59));
      }
      return { iso: d.toISOString(), text: monthDay[0].trim() };
    }
  }

  // "6/21", "6/21/26", "06-21-2026"
  const numeric = window.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numeric) {
    const month = parseInt(numeric[1], 10) - 1;
    const day = parseInt(numeric[2], 10);
    let yr = numeric[3] ? parseInt(numeric[3], 10) : year;
    if (yr < 100) yr += 2000;
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      let d = new Date(Date.UTC(yr, month, day, 23, 59, 59));
      if (!numeric[3] && d.getTime() < now.getTime() - 7 * 864e5) {
        d = new Date(Date.UTC(yr + 1, month, day, 23, 59, 59));
      }
      return { iso: d.toISOString(), text: numeric[0].trim() };
    }
  }

  return null;
}

export function detectDeals(description: string): DetectedDeal[] {
  if (!description) return [];
  const found: DetectedDeal[] = [...findPartnerListDeals(description)];
  const expiry = parseExpiry(description);

  for (const rule of PROMO_RULES) {
    for (const match of description.matchAll(rule.pattern)) {
      const idx = match.index ?? 0;
      const url = findDealUrl(description, idx);

      // A bare sponsor mention with no findable link isn't actionable.
      if (rule.label === "Sponsor" && !url) continue;

      const code = match[1] && /[A-Z]/i.test(match[1]) && !match[1].includes("%") && !match[1].includes("$")
        ? match[1].toUpperCase()
        : null;

      // context: the sentence/line containing the match
      const start = Math.max(0, description.lastIndexOf("\n", idx));
      let end = description.indexOf("\n", idx);
      if (end === -1) end = Math.min(description.length, idx + 160);
      const context = description.slice(start, end).trim().replace(/\s+/g, " ").slice(0, 200);

      found.push({
        label: rule.label,
        code,
        context,
        url,
        expiresAt: expiry?.iso ?? null,
        expiryText: expiry?.text ?? null,
      });
    }
  }

  // Dedupe: several rules often match the same sponsor sentence. Keep one deal
  // per (code or context), preferring entries that captured an actual code.
  const deduped: DetectedDeal[] = [];
  for (const deal of found.sort((a, b) => Number(b.code !== null) - Number(a.code !== null))) {
    const dupe = deduped.some(
      (d) => (deal.code !== null && d.code === deal.code) || d.context === deal.context,
    );
    if (!dupe) deduped.push(deal);
  }
  return deduped;
}

// ── RSS channel fetcher (includes title + description + publish date) ────────

interface RssVideo {
  id: string;
  title: string;
  url: string;
  description: string;
  publishedAt: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function fetchRssXml(
  channelId: string,
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 350;
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let xml = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    lastStatus = res.status;
    if (res.ok) {
      xml = await res.text();
      break;
    }
    // YouTube's RSS endpoint intermittently 404s/429s on valid channels — back
    // off (with jitter, so concurrent scans don't retry in lockstep) and retry.
    if (attempt < attempts - 1) {
      const delay = baseDelayMs * (attempt + 1) + Math.random() * baseDelayMs;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (!xml) throw new Error(`Could not load this channel's videos (${lastStatus}).`);
  return xml;
}

export async function fetchRssVideos(channelId: string, max = 5): Promise<RssVideo[]> {
  const xml = await fetchRssXml(channelId);
  const videos: RssVideo[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null && videos.length < max) {
    const entry = m[1];
    const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
    const descMatch = entry.match(/<media:description>([\s\S]*?)<\/media:description>/);
    const dateMatch = entry.match(/<published>([^<]+)<\/published>/);
    if (idMatch && titleMatch) {
      videos.push({
        id: idMatch[1],
        title: decodeEntities(titleMatch[1]),
        url: `https://www.youtube.com/watch?v=${idMatch[1]}`,
        description: descMatch ? decodeEntities(descMatch[1]) : "",
        publishedAt: dateMatch ? dateMatch[1] : "",
      });
    }
  }
  return videos;
}

// ── Channel metadata resolver (feed title; used as fallback) ─────────────────

export async function resolveChannelName(channelId: string): Promise<string> {
  try {
    const xml = await fetchRssXml(channelId);
    // The feed-level <title> (before the first <entry>) is the channel name.
    const head = xml.slice(0, xml.indexOf("<entry>"));
    const title = head.match(/<title>([^<]+)<\/title>/);
    return title ? decodeEntities(title[1]) : channelId;
  } catch {
    return channelId;
  }
}

// ── Shared: attach detected deals to a batch of RSS videos ───────────────────

function toScannedVideos(videos: RssVideo[]): ScannedVideo[] {
  return videos.map((v) => ({
    id: v.id,
    title: v.title,
    url: v.url,
    publishedAt: v.publishedAt,
    deals: detectDeals(v.description),
  }));
}

// ── Public: preview a channel's last N videos + deals (no save) ──────────────

export async function previewChannel(channelId: string, max = 5): Promise<ScannedVideo[]> {
  return toScannedVideos(await fetchRssVideos(channelId, max));
}

// ── Public: scan + persist deals for a channel, then notify ──────────────────

export async function scanChannelAndSave(
  channelId: string,
  channelName: string,
  max = 5,
): Promise<{ videos: ScannedVideo[]; newDeals: number }> {
  const scanned = toScannedVideos(await fetchRssVideos(channelId, max));
  const freshDeals: any[] = [];

  for (const v of scanned) {
    db.markVideoScanned(v.id);

    for (const d of v.deals) {
      if (db.dealExists(v.id, d.label, d.context)) continue;
      const saved = db.addDeal({
        videoId: v.id,
        videoTitle: v.title,
        channelName,
        videoUrl: v.url,
        label: d.label,
        code: d.code,
        context: d.context,
        dealUrl: d.url,
        expiresAt: d.expiresAt,
        expiryText: d.expiryText,
      });
      freshDeals.push(saved);
    }
  }

  if (freshDeals.length > 0) {
    await notifyMissedDeals(freshDeals, channelName);
  }

  return { videos: scanned, newDeals: freshDeals.length };
}