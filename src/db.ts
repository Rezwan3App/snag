import { existsSync, readFileSync, writeFileSync } from "fs";

const DB_PATH = "./snag.json";

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

interface DbData {
  channels: Channel[];
  deals: Deal[];
  scannedVideos: string[];
  nextDealId: number;
  subscriber: Subscriber | null;
  notifications: Notification[];
  nextNotificationId: number;
}

function load(): DbData {
  const fallback: DbData = {
    channels: [],
    deals: [],
    scannedVideos: [],
    nextDealId: 1,
    subscriber: null,
    notifications: [],
    nextNotificationId: 1,
  };
  if (!existsSync(DB_PATH)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(DB_PATH, "utf8")) };
  } catch {
    return fallback;
  }
}

function save(data: DbData) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Every write follows the same load → mutate → save shape; do it once here.
function mutate<T>(fn: (data: DbData) => T): T {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

export const db = {
  getChannels: (): Channel[] => load().channels,

  addChannel: (channel: Omit<Channel, "addedAt">): Channel =>
    mutate((data) => {
      const existing = data.channels.find((c) => c.id === channel.id);
      if (existing) return existing;
      const entry: Channel = { ...channel, addedAt: new Date().toISOString() };
      data.channels.push(entry);
      return entry;
    }),

  removeChannel: (id: string) =>
    mutate((data) => {
      data.channels = data.channels.filter((c) => c.id !== id);
    }),

  getDeals: (): Deal[] => load().deals,

  dealExists: (videoId: string, code: string | null, label: string): boolean =>
    load().deals.some((d) => d.videoId === videoId && d.code === code && d.label === label),

  addDeal: (deal: Omit<Deal, "id" | "detectedAt">): Deal =>
    mutate((data) => {
      const entry: Deal = { ...deal, id: data.nextDealId++, detectedAt: new Date().toISOString() };
      data.deals.unshift(entry);
      return entry;
    }),

  removeDeal: (id: number) =>
    mutate((data) => {
      data.deals = data.deals.filter((d) => d.id !== id);
    }),

  isVideoScanned: (videoId: string): boolean => load().scannedVideos.includes(videoId),

  markVideoScanned: (videoId: string) =>
    mutate((data) => {
      if (!data.scannedVideos.includes(videoId)) data.scannedVideos.push(videoId);
    }),

  // ── Subscriber (single user for MVP) ──────────────────────────────────────
  getSubscriber: (): Subscriber | null => load().subscriber,

  setSubscriber: (phone: string): Subscriber =>
    mutate((data) => {
      data.subscriber = { phone, enabled: true, subscribedAt: new Date().toISOString() };
      return data.subscriber!;
    }),

  setSubscriberEnabled: (enabled: boolean): Subscriber | null =>
    mutate((data) => {
      if (data.subscriber) data.subscriber.enabled = enabled;
      return data.subscriber;
    }),

  removeSubscriber: () =>
    mutate((data) => {
      data.subscriber = null;
    }),

  // ── Notifications log ─────────────────────────────────────────────────────
  getNotifications: (): Notification[] => load().notifications,

  addNotification: (n: Omit<Notification, "id" | "sentAt">): Notification =>
    mutate((data) => {
      const entry: Notification = { ...n, id: data.nextNotificationId++, sentAt: new Date().toISOString() };
      data.notifications.unshift(entry);
      if (data.notifications.length > 50) data.notifications = data.notifications.slice(0, 50);
      return entry;
    }),
};
