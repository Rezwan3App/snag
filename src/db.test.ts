import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, rmSync } from "fs";
import { createDb } from "./db";

const openDbs: ReturnType<typeof createDb>[] = [];
const paths: string[] = [];
let counter = 0;

function freshDb() {
  const path = `./snag.test.${counter++}.db`;
  paths.push(path);
  const db = createDb(path);
  openDbs.push(db);
  return db;
}

afterAll(() => {
  for (const db of openDbs) db.close();
  for (const path of paths) {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(p)) rmSync(p);
    }
  }
});

describe("channels", () => {
  test("addChannel then getChannels returns it", () => {
    const db = freshDb();
    db.addChannel({ id: "c1", name: "Creator One", url: "https://youtube.com/c1" });
    expect(db.getChannels().map((c) => c.id)).toEqual(["c1"]);
  });

  test("addChannel is idempotent for the same id", () => {
    const db = freshDb();
    const first = db.addChannel({ id: "c1", name: "Creator One", url: "https://youtube.com/c1" });
    const second = db.addChannel({ id: "c1", name: "Different Name", url: "https://youtube.com/c1" });
    expect(second.addedAt).toBe(first.addedAt);
    expect(db.getChannels().length).toBe(1);
  });

  test("removeChannel removes only the matching channel", () => {
    const db = freshDb();
    db.addChannel({ id: "c1", name: "One", url: "u1" });
    db.addChannel({ id: "c2", name: "Two", url: "u2" });
    db.removeChannel("c1");
    expect(db.getChannels().map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("deals", () => {
  const baseDeal = {
    videoId: "v1",
    videoTitle: "A Video",
    channelName: "Creator One",
    videoUrl: "https://youtu.be/v1",
    label: "Promo code",
    code: "SAVE10" as string | null,
    context: "use code SAVE10",
    dealUrl: null as string | null,
  };

  test("addDeal then getDeals returns it, newest first", () => {
    const db = freshDb();
    db.addDeal(baseDeal);
    db.addDeal({ ...baseDeal, videoId: "v2", code: "SAVE20" });
    const deals = db.getDeals();
    expect(deals.map((d) => d.code)).toEqual(["SAVE20", "SAVE10"]);
  });

  test("dealExists matches on videoId + label + context", () => {
    const db = freshDb();
    db.addDeal(baseDeal);
    expect(db.dealExists("v1", "Promo code", "use code SAVE10")).toBe(true);
    expect(db.dealExists("v1", "Promo code", "a different sentence")).toBe(false);
    expect(db.dealExists("v2", "Promo code", "use code SAVE10")).toBe(false);
  });

  test("dealExists distinguishes two null-code deals on the same video (e.g. two sponsor mentions)", () => {
    const db = freshDb();
    db.addDeal({ ...baseDeal, code: null, context: "Thanks to Secretlab for the chair: https://lmg.gg/secretlabltt" });
    // A second, different sponsor mention on the same video/label must NOT
    // read as "already exists" just because both have a null code.
    expect(db.dealExists("v1", "Promo code", "Thanks to PIA for the VPN: https://piavpn.com/ltt")).toBe(false);
    expect(db.dealExists("v1", "Promo code", "Thanks to Secretlab for the chair: https://lmg.gg/secretlabltt")).toBe(true);
  });

  test("removeDeal deletes only that deal", () => {
    const db = freshDb();
    const a = db.addDeal(baseDeal);
    const b = db.addDeal({ ...baseDeal, videoId: "v2", code: "SAVE20" });
    db.removeDeal(a.id);
    expect(db.getDeals().map((d) => d.id)).toEqual([b.id]);
  });
});

describe("scanned videos", () => {
  test("markVideoScanned then isVideoScanned is true, others stay false", () => {
    const db = freshDb();
    db.markVideoScanned("v1");
    expect(db.isVideoScanned("v1")).toBe(true);
    expect(db.isVideoScanned("v2")).toBe(false);
  });
});

describe("subscriber", () => {
  test("setSubscriber then getSubscriber returns an enabled subscriber", () => {
    const db = freshDb();
    db.setSubscriber("+14155552671");
    expect(db.getSubscriber()).toMatchObject({ phone: "+14155552671", enabled: true });
  });

  test("setSubscriberEnabled toggles the existing subscriber", () => {
    const db = freshDb();
    db.setSubscriber("+14155552671");
    db.setSubscriberEnabled(false);
    expect(db.getSubscriber()?.enabled).toBe(false);
  });

  test("removeSubscriber clears it back to null", () => {
    const db = freshDb();
    db.setSubscriber("+14155552671");
    db.removeSubscriber();
    expect(db.getSubscriber()).toBeNull();
  });
});

describe("notifications", () => {
  test("addNotification then getNotifications returns it, newest first", () => {
    const db = freshDb();
    db.addNotification({ phone: "+1", body: "a", dealCount: 1, source: "x", mode: "demo", ok: true, error: null });
    db.addNotification({ phone: "+1", body: "b", dealCount: 1, source: "x", mode: "demo", ok: true, error: null });
    expect(db.getNotifications().map((n) => n.body)).toEqual(["b", "a"]);
  });

  test("keeps only the most recent 50 notifications", () => {
    const db = freshDb();
    for (let i = 0; i < 55; i++) {
      db.addNotification({ phone: "+1", body: `n${i}`, dealCount: 1, source: "x", mode: "demo", ok: true, error: null });
    }
    const notifications = db.getNotifications();
    expect(notifications.length).toBe(50);
    expect(notifications[0].body).toBe("n54");
  });
});

describe("persistence", () => {
  test("data survives reopening the same db path", () => {
    const path = `./snag.test.${counter++}.db`;
    paths.push(path);

    const db = createDb(path);
    openDbs.push(db);
    db.addChannel({ id: "c1", name: "Creator One", url: "u1" });
    db.addDeal({
      videoId: "v1",
      videoTitle: "A Video",
      channelName: "Creator One",
      videoUrl: "https://youtu.be/v1",
      label: "Promo code",
      code: "SAVE10",
      context: "use code SAVE10",
      dealUrl: null,
    });
    db.close();

    const reopened = createDb(path);
    openDbs.push(reopened);
    expect(reopened.getChannels().map((c) => c.id)).toEqual(["c1"]);
    expect(reopened.getDeals().map((d) => d.code)).toEqual(["SAVE10"]);
  });
});
