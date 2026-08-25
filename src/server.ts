import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { db } from "./db";
import {
  searchChannels,
  previewChannel,
  scanChannelAndSave,
  resolveChannelName,
} from "./scanner";
import {
  normalizePhone,
  maskPhone,
  buildDealSms,
  sendSms,
  SMS_CONFIGURED,
} from "./notify";

const app = new Hono();
app.use("*", cors());

// ── Static frontend ──────────────────────────────────────────────────────────
app.use("/*", serveStatic({ root: "./public" }));

// ── API: Channel search (type a YouTuber name → suggestions) ─────────────────
app.get("/api/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q || q.length < 2) return c.json({ results: [] });
  try {
    const results = await searchChannels(q);
    return c.json({ results });
  } catch (e: any) {
    return c.json({ error: e.message, results: [] }, 500);
  }
});

// ── API: Preview a channel's last 5 videos + detected deals ──────────────────
app.get("/api/channel/:id/preview", async (c) => {
  try {
    const videos = await previewChannel(c.req.param("id"), 5);
    return c.json({ videos });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── API: Homepage "spotlight" strip ───────────────────────────────────────────
// A fixed set of well-known channels (the same names already in the search
// chips), scanned read-only — no DB writes, no SMS — so a first-time visitor
// sees Snag actually finding real deals instead of an empty search box.
// Cached briefly so a burst of visitors doesn't hammer YouTube's RSS feed.
const SPOTLIGHT_CHANNELS = [
  { id: "UCXuqSBlHAE6Xw-yeJA0Tunw", name: "Linus Tech Tips" },
  { id: "UCBJycsmduvYEL83R_U4JriQ", name: "MKBHD" },
  { id: "UCX6OQ3DkcsbYNE6H8uQQuVA", name: "MrBeast" },
  { id: "UCY1kMZp36IQSyNx_9h4mpCg", name: "Mark Rober" },
  { id: "UC4ijq8Cg-8zQKx8OH12dUSw", name: "Kara and Nate" },
  { id: "UCoOae5nYA7VqaXzerajD0lg", name: "Ali Abdaal" },
  { id: "UCtinbF-Q-fVthA0qrFQTgXQ", name: "Casey Neistat" },
  { id: "UCsTcErHg8oDvUnTzoqsYeNw", name: "Unbox Therapy" },
  { id: "UCRijo3ddMTht_IHyNSNXpNQ", name: "Dude Perfect" },
];

interface SpotlightDeal {
  channelName: string;
  channelId: string;
  videoTitle: string;
  videoUrl: string;
  label: string;
  code: string | null;
  url: string | null;
  publishedAt: string;
}

let spotlightCache: { deals: SpotlightDeal[]; expiresAt: number } | null = null;
const SPOTLIGHT_TTL_MS = 10 * 60_000;

async function getSpotlightDeals(): Promise<SpotlightDeal[]> {
  if (spotlightCache && spotlightCache.expiresAt > Date.now()) return spotlightCache.deals;

  const perChannel = await Promise.all(
    SPOTLIGHT_CHANNELS.map(async (ch) => {
      try {
        const videos = await previewChannel(ch.id, 5);
        return videos.flatMap((v) =>
          v.deals.map((d) => ({
            channelName: ch.name,
            channelId: ch.id,
            videoTitle: v.title,
            videoUrl: v.url,
            label: d.label,
            code: d.code,
            url: d.url,
            publishedAt: v.publishedAt,
          })),
        );
      } catch {
        return [];
      }
    }),
  );

  // Same evergreen sponsor block repeats across a channel's last few videos
  // (e.g. LTT's "Channel Partners" list) — dedupe by (channel, link) and cap
  // per channel so the strip shows variety across creators, not one channel's
  // sponsor list three times over.
  const sorted = perChannel.flat().sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const seenLinks = new Set<string>();
  const perChannelCount = new Map<string, number>();
  const deals: SpotlightDeal[] = [];
  for (const d of sorted) {
    const dedupeKey = `${d.channelId}|${d.url}`;
    if (seenLinks.has(dedupeKey)) continue;
    if ((perChannelCount.get(d.channelId) ?? 0) >= 2) continue;
    seenLinks.add(dedupeKey);
    perChannelCount.set(d.channelId, (perChannelCount.get(d.channelId) ?? 0) + 1);
    deals.push(d);
    if (deals.length >= 12) break;
  }

  spotlightCache = { deals, expiresAt: Date.now() + SPOTLIGHT_TTL_MS };
  return deals;
}

app.get("/api/spotlight", async (c) => {
  try {
    return c.json({ deals: await getSpotlightDeals() });
  } catch (e: any) {
    return c.json({ deals: [], error: e.message }, 500);
  }
});

// ── API: Deals ───────────────────────────────────────────────────────────────
app.get("/api/deals", (c) => c.json(db.getDeals()));

app.delete("/api/deals/:id", (c) => {
  db.removeDeal(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ── API: Watched channels ────────────────────────────────────────────────────
app.get("/api/channels", (c) => c.json(db.getChannels()));

app.post("/api/channels", async (c) => {
  const { id, name, url, thumbnail } = await c.req.json<{
    id?: string;
    name?: string;
    url?: string;
    thumbnail?: string;
  }>();

  if (!id) return c.json({ error: "Missing channel id." }, 400);
  const chName = name ?? (await resolveChannelName(id));

  const channel = db.addChannel({
    id,
    name: chName,
    url: url ?? `https://www.youtube.com/channel/${id}`,
    thumbnail: thumbnail ?? null,
  });

  // Scan + text deals now, so the response can report how many were found
  // (the frontend reads `newDeals` to show "texted you N deals" vs. "you'll
  // get a text later" — silently wrong without this).
  const { newDeals } = await scanChannelAndSave(id, chName, 5).catch((e) => {
    console.error(e);
    return { videos: [], newDeals: 0 };
  });

  return c.json({ ok: true, channel, newDeals });
});

app.delete("/api/channels/:id", (c) => {
  db.removeChannel(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/channels/:id/scan", async (c) => {
  const name = c.req.query("name") ?? "";
  try {
    const channelName = name || (await resolveChannelName(c.req.param("id")));
    const result = await scanChannelAndSave(c.req.param("id"), channelName, 5);
    return c.json({ ok: true, newDeals: result.newDeals, videos: result.videos.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/api/scan-all", async (c) => {
  const channels = db.getChannels();
  for (const ch of channels) scanChannelAndSave(ch.id, ch.name, 5).catch(console.error);
  return c.json({ ok: true, channelsQueued: channels.length });
});

// ── API: SMS subscriber ──────────────────────────────────────────────────────
app.get("/api/sms", (c) => {
  const sub = db.getSubscriber();
  return c.json({
    subscribed: Boolean(sub),
    enabled: sub?.enabled ?? false,
    phoneMasked: sub ? maskPhone(sub.phone) : null,
    smsConfigured: SMS_CONFIGURED,
  });
});

app.post("/api/sms/subscribe", async (c) => {
  const { phone } = await c.req.json<{ phone: string }>();
  const normalized = normalizePhone(phone ?? "");
  if (!normalized) {
    return c.json({ error: "Enter a valid phone number (e.g. +1 415 555 2671 or 4155552671)." }, 400);
  }
  db.setSubscriber(normalized);

  const welcome =
    "🎯 You're set on Snag. We'll text you the promo codes & deals buried in new videos from the channels you follow — so you never have to sit through the sponsor read again.";
  const result = await sendSms(normalized, welcome);
  db.addNotification({
    phone: normalized,
    body: welcome,
    dealCount: 0,
    source: "Welcome",
    mode: result.mode,
    ok: result.ok,
    error: result.error ?? null,
  });

  return c.json({ ok: true, phoneMasked: maskPhone(normalized), mode: result.mode, smsConfigured: SMS_CONFIGURED });
});

app.post("/api/sms/toggle", async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  const sub = db.setSubscriberEnabled(Boolean(enabled));
  if (!sub) return c.json({ error: "No subscriber set." }, 400);
  return c.json({ ok: true, enabled: sub.enabled });
});

app.delete("/api/sms", (c) => {
  db.removeSubscriber();
  return c.json({ ok: true });
});

app.get("/api/notifications", (c) => c.json(db.getNotifications()));

app.post("/api/sms/test", async (c) => {
  const sub = db.getSubscriber();
  if (!sub) return c.json({ error: "Add your number first." }, 400);

  const deals = db.getDeals().slice(0, 3);
  let body: string;
  if (deals.length) {
    body = buildDealSms(
      deals.map((d) => ({
        channelName: d.channelName,
        videoTitle: d.videoTitle,
        videoUrl: d.videoUrl,
        label: d.label,
        code: d.code,
        dealUrl: d.dealUrl,
      })),
    );
  } else {
    body =
      '🎯 Sample Snag alert: "Use code LTT for 10% off your order" — link in description. Real alerts arrive automatically when channels you follow drop new videos.';
  }

  const result = await sendSms(sub.phone, body);
  db.addNotification({
    phone: sub.phone,
    body,
    dealCount: deals.length,
    source: "Test",
    mode: result.mode,
    ok: result.ok,
    error: result.error ?? null,
  });
  return c.json({ ok: result.ok, mode: result.mode, error: result.error });
});

// ── Background auto-scan ─────────────────────────────────────────────────────
// Re-scan every watched channel periodically so new uploads trigger texts
// without anyone opening the app.
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MINUTES ?? 30) * 60_000;
setInterval(() => {
  for (const ch of db.getChannels()) {
    scanChannelAndSave(ch.id, ch.name, 5).catch((e) =>
      console.error(`Auto-scan failed for ${ch.name}:`, e.message),
    );
  }
}, SCAN_INTERVAL_MS);

// ── Boot ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 4242);
export default { port: PORT, fetch: app.fetch };
console.log(`Snag running at http://localhost:${PORT}`);
