import { db } from "./db";

// ── Phone validation (E.164-ish) ─────────────────────────────────────────────
// Accepts numbers like +14155552671. Normalizes US 10-digit input to +1XXXXXXXXXX.

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim().replace(/[\s()\-.]/g, "");
  // Already E.164
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  // Bare US 10-digit
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  // US with leading 1
  if (/^1\d{10}$/.test(trimmed)) return `+${trimmed}`;
  return null;
}

export function maskPhone(phone: string): string {
  // +14155552671 -> +1 ••• ••• 2671
  if (phone.length < 4) return phone;
  return `${phone.slice(0, 2)} ••• ••• ${phone.slice(-4)}`;
}

// ── Message builder ──────────────────────────────────────────────────────────

interface DealLike {
  channelName: string;
  videoTitle: string;
  videoUrl: string;
  label: string;
  code: string | null;
  dealUrl: string | null;
}

export function buildDealSms(deals: DealLike[]): string {
  if (deals.length === 0) return "";

  // Group by video so one new upload = one tidy text.
  const byVideo = new Map<string, DealLike[]>();
  for (const d of deals) {
    const arr = byVideo.get(d.videoUrl) ?? [];
    arr.push(d);
    byVideo.set(d.videoUrl, arr);
  }

  const blocks: string[] = [];
  for (const [videoUrl, vidDeals] of byVideo) {
    const first = vidDeals[0];
    const lines: string[] = [];
    lines.push(`🎯 ${first.channelName}: deals you'd have missed`);
    lines.push(`📺 ${truncate(first.videoTitle, 60)}`);

    for (const d of vidDeals.slice(0, 4)) {
      const codePart = d.code ? `Code ${d.code}` : d.label;
      const link = d.dealUrl || videoUrl;
      lines.push(`• ${codePart} → ${link}`);
    }
    if (vidDeals.length > 4) lines.push(`…+${vidDeals.length - 4} more on Snag`);
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Sender (Twilio if configured, otherwise demo mode) ───────────────────────

export interface SendResult {
  mode: "twilio" | "demo";
  ok: boolean;
  error?: string;
}

// The API has no auth, so on a public deploy anyone can trigger texts. Cap real
// sends so a script can't run up the Twilio bill.
// ponytail: global in-memory cap, resets on restart; per-number/per-IP limits or real auth if abused.
// A typo'd value must not turn the cap off (length >= NaN is always false).
// Read per call so tests can change it.
const maxPerHour = () => {
  const n = Number(process.env.SMS_MAX_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? n : 20;
};
const recentSends: number[] = [];

export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (body.length > 1600) body = body.slice(0, 1599) + "…"; // Twilio's per-message cap
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  // Demo mode: no provider configured. Log it so the UI can show what *would* send.
  if (!sid || !token || !from) {
    console.log(`[Snag SMS · DEMO] → ${to}\n${body}\n`);
    return { mode: "demo", ok: true };
  }

  const hourAgo = Date.now() - 3_600_000;
  while (recentSends.length && recentSends[0]! < hourAgo) recentSends.shift();
  if (recentSends.length >= maxPerHour()) {
    return { mode: "twilio", ok: false, error: "Hourly text limit reached. Try again later." };
  }
  recentSends.push(Date.now());

  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { mode: "twilio", ok: false, error: `Twilio ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { mode: "twilio", ok: true };
  } catch (e: any) {
    return { mode: "twilio", ok: false, error: e.message };
  }
}

// ── High-level: notify the subscriber about newly found deals ────────────────

// Returns false only when a send was attempted and failed, so callers can retry.
export async function notifyMissedDeals(deals: DealLike[], source: string): Promise<boolean> {
  if (deals.length === 0) return true;
  const sub = db.getSubscriber();
  if (!sub || !sub.enabled) return true;

  const body = buildDealSms(deals);
  const result = await sendSms(sub.phone, body);

  db.addNotification({
    phone: sub.phone,
    body,
    dealCount: deals.length,
    source,
    mode: result.mode,
    ok: result.ok,
    error: result.error ?? null,
  });
  return result.ok;
}

export const SMS_CONFIGURED = Boolean(
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER,
);
