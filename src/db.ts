import { Database } from "bun:sqlite";

interface Channel {
  id: string;
  name: string;
  url: string;
  thumbnail?: string | null;
  addedAt: string;
}

interface Deal {
  id: number;
  videoId: string;
  videoTitle: string;
  channelName: string;
  videoUrl: string;
  label: string;
  code: string | null;
  context: string;
  dealUrl: string | null;
  expiresAt?: string | null;
  expiryText?: string | null;
  detectedAt: string;
}

interface Subscriber {
  phone: string;
  enabled: boolean;
  subscribedAt: string;
}

interface Notification {
  id: number;
  phone: string;
  body: string;
  dealCount: number;
  source: string;
  mode: "twilio" | "demo";
  ok: boolean;
  error: string | null;
  sentAt: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    thumbnail TEXT,
    addedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    videoId TEXT NOT NULL,
    videoTitle TEXT NOT NULL,
    channelName TEXT NOT NULL,
    videoUrl TEXT NOT NULL,
    label TEXT NOT NULL,
    code TEXT,
    context TEXT NOT NULL,
    dealUrl TEXT,
    expiresAt TEXT,
    expiryText TEXT,
    detectedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scanned_videos (
    videoId TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS subscriber (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phone TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    subscribedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    body TEXT NOT NULL,
    dealCount INTEGER NOT NULL,
    source TEXT NOT NULL,
    mode TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    sentAt TEXT NOT NULL
  );
`;

function toDeal(row: any): Deal {
  return { ...row, expiresAt: row.expiresAt ?? null, expiryText: row.expiryText ?? null };
}

function toNotification(row: any): Notification {
  return { ...row, ok: !!row.ok };
}

export function createDb(path: string) {
  const conn = new Database(path, { create: true });
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec(SCHEMA);

  return {
    getChannels: (): Channel[] => conn.query("SELECT * FROM channels ORDER BY addedAt ASC").all() as Channel[],

    addChannel: (channel: Omit<Channel, "addedAt">): Channel => {
      const existing = conn.query("SELECT * FROM channels WHERE id = ?").get(channel.id) as Channel | null;
      if (existing) return existing;
      const entry: Channel = { ...channel, thumbnail: channel.thumbnail ?? null, addedAt: new Date().toISOString() };
      conn
        .query("INSERT INTO channels (id, name, url, thumbnail, addedAt) VALUES (?, ?, ?, ?, ?)")
        .run(entry.id, entry.name, entry.url, entry.thumbnail ?? null, entry.addedAt);
      return entry;
    },

    removeChannel: (id: string) => {
      conn.query("DELETE FROM channels WHERE id = ?").run(id);
    },

    getDeals: (): Deal[] =>
      (conn.query("SELECT * FROM deals ORDER BY id DESC").all() as any[]).map(toDeal),

    // Keyed on context (the matched sentence), not code: several deals on the
    // same video can share a label with no code at all (e.g. two separate
    // "Sponsor" mentions), and code alone would collapse them together.
    dealExists: (videoId: string, label: string, context: string): boolean => {
      const row = conn
        .query("SELECT 1 FROM deals WHERE videoId = ? AND label = ? AND context = ?")
        .get(videoId, label, context);
      return !!row;
    },

    addDeal: (deal: Omit<Deal, "id" | "detectedAt">): Deal => {
      const detectedAt = new Date().toISOString();
      const result = conn
        .query(
          `INSERT INTO deals (videoId, videoTitle, channelName, videoUrl, label, code, context, dealUrl, expiresAt, expiryText, detectedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deal.videoId,
          deal.videoTitle,
          deal.channelName,
          deal.videoUrl,
          deal.label,
          deal.code,
          deal.context,
          deal.dealUrl,
          deal.expiresAt ?? null,
          deal.expiryText ?? null,
          detectedAt,
        );
      return { ...deal, id: Number(result.lastInsertRowid), detectedAt };
    },

    removeDeal: (id: number) => {
      conn.query("DELETE FROM deals WHERE id = ?").run(id);
    },

    isVideoScanned: (videoId: string): boolean =>
      !!conn.query("SELECT 1 FROM scanned_videos WHERE videoId = ?").get(videoId),

    markVideoScanned: (videoId: string) => {
      conn.query("INSERT OR IGNORE INTO scanned_videos (videoId) VALUES (?)").run(videoId);
    },

    // ── Subscriber (single user for MVP) ──────────────────────────────────
    getSubscriber: (): Subscriber | null => {
      const row = conn.query("SELECT phone, enabled, subscribedAt FROM subscriber WHERE id = 1").get() as any;
      return row ? { ...row, enabled: !!row.enabled } : null;
    },

    setSubscriber: (phone: string): Subscriber => {
      const subscribedAt = new Date().toISOString();
      conn
        .query(
          `INSERT INTO subscriber (id, phone, enabled, subscribedAt) VALUES (1, ?, 1, ?)
           ON CONFLICT (id) DO UPDATE SET phone = excluded.phone, enabled = 1, subscribedAt = excluded.subscribedAt`,
        )
        .run(phone, subscribedAt);
      return { phone, enabled: true, subscribedAt };
    },

    setSubscriberEnabled: (enabled: boolean): Subscriber | null => {
      conn.query("UPDATE subscriber SET enabled = ? WHERE id = 1").run(enabled ? 1 : 0);
      const row = conn.query("SELECT phone, enabled, subscribedAt FROM subscriber WHERE id = 1").get() as any;
      return row ? { ...row, enabled: !!row.enabled } : null;
    },

    removeSubscriber: () => {
      conn.query("DELETE FROM subscriber WHERE id = 1").run();
    },

    // ── Notifications log ──────────────────────────────────────────────────
    getNotifications: (): Notification[] =>
      (conn.query("SELECT * FROM notifications ORDER BY id DESC").all() as any[]).map(toNotification),

    addNotification: (n: Omit<Notification, "id" | "sentAt">): Notification => {
      const sentAt = new Date().toISOString();
      const result = conn
        .query(
          `INSERT INTO notifications (phone, body, dealCount, source, mode, ok, error, sentAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(n.phone, n.body, n.dealCount, n.source, n.mode, n.ok ? 1 : 0, n.error, sentAt);
      // Keep only the most recent 50.
      conn
        .query(
          "DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 50)",
        )
        .run();
      return { ...n, id: Number(result.lastInsertRowid), sentAt };
    },

    close: () => conn.close(),
  };
}

// Lazy singleton: importing this module (e.g. transitively, for an unrelated
// export) must not touch disk. The real connection only opens on first use.
type Db = ReturnType<typeof createDb>;
let _db: Db | null = null;
export const db: Db = new Proxy({} as Db, {
  get(_target, prop: keyof Db) {
    if (!_db) _db = createDb(process.env.SNAG_DB_PATH ?? "./snag.db");
    return _db[prop];
  },
});
