import { describe, expect, test } from "bun:test";
import { detectDeals, fetchRssXml } from "./scanner";
import { normalizePhone, maskPhone, buildDealSms } from "./notify";

describe("detectDeals", () => {
  test("finds a promo code", () => {
    const deals = detectDeals("Use code LTT at checkout for 15% off your order.");
    expect(deals.length).toBe(1);
    expect(deals[0].code).toBe("LTT");
  });

  test("dedupes when multiple rules match the same sponsor sentence", () => {
    const desc =
      "Get 20% off DeleteMe consumer plans when you go to http://joindeleteme.com/LTT20 and use promo code LTT20 at checkout!";
    const deals = detectDeals(desc);
    expect(deals.length).toBe(1);
    expect(deals[0].code).toBe("LTT20");
    expect(deals[0].url).toBe("http://joindeleteme.com/LTT20");
  });

  test("pairs each deal with its own nearby sponsor link", () => {
    const desc = [
      "Visit https://www.squarespace.com/WAN and use offer code WAN for 10% off",
      "",
      "Check out our forum: https://linustechtips.com/topic",
    ].join("\n");
    const deals = detectDeals(desc);
    const wan = deals.find((d) => d.code === "WAN");
    expect(wan?.url).toBe("https://www.squarespace.com/WAN");
  });

  test("handles multi-subdomain sponsor links", () => {
    const deals = detectDeals("Visit https://squarespace.syuh.net/LTT and use offer code LTT for 10% off");
    expect(deals[0].code).toBe("LTT");
    expect(deals[0].url).toBe("https://squarespace.syuh.net/LTT");
  });

  test("ignores social links as deal URLs", () => {
    const deals = detectDeals("Use code SAVE10 today! Follow us: https://twitter.com/creator");
    expect(deals[0].code).toBe("SAVE10");
    expect(deals[0].url).toBeNull();
  });

  test("parses an expiry date near a trigger word", () => {
    const deals = detectDeals("Use code SUMMER for 20% off — offer ends December 25, 2026.");
    const withExpiry = deals.find((d) => d.expiresAt);
    expect(withExpiry?.expiresAt).toContain("2026-12-25");
  });

  test("returns nothing for a plain description", () => {
    expect(detectDeals("We built a new PC and benchmarked some games.")).toEqual([]);
  });

  test("handles empty input", () => {
    expect(detectDeals("")).toEqual([]);
  });

  test("catches multiple distinct promo codes in one description", () => {
    const desc = [
      "Use code FIRST for 10% off at https://brand-one.com/deal",
      "Also use code SECOND for 20% off at https://brand-two.com/deal",
    ].join("\n");
    const deals = detectDeals(desc);
    const codes = deals.map((d) => d.code).sort();
    expect(codes).toEqual(["FIRST", "SECOND"]);
  });

  test("detects a plain sponsor mention with no code, paired with its link", () => {
    const desc =
      "Thanks to Meter for sponsoring this video! Go to https://meter.com/ltt to book a demo now!";
    const deals = detectDeals(desc);
    expect(deals.length).toBe(1);
    expect(deals[0].label).toBe("Sponsor");
    expect(deals[0].code).toBeNull();
    expect(deals[0].url).toBe("https://meter.com/ltt");
  });

  test("detects 'sponsored by' and 'brought to you by' sponsor phrasing", () => {
    const a = detectDeals("Sponsored by ThreatLocker: https://www.threatlocker.com/ltt");
    expect(a[0].label).toBe("Sponsor");
    expect(a[0].url).toBe("https://www.threatlocker.com/ltt");

    const b = detectDeals("This video is brought to you by dbrand: https://dbrand.com/shop/pixel11");
    expect(b[0].label).toBe("Sponsor");
    expect(b[0].url).toBe("https://dbrand.com/shop/pixel11");
  });

  test("ignores a bare sponsor mention with no resolvable link", () => {
    const deals = detectDeals("Huge thanks to our sponsor for making this video possible.");
    expect(deals).toEqual([]);
  });

  test("does not double-count a sponsor mention that also has an explicit code", () => {
    const desc = "Sponsored by Squarespace — use code WAN for 10% off at https://squarespace.com/WAN";
    const deals = detectDeals(desc);
    expect(deals.length).toBe(1);
    expect(deals[0].code).toBe("WAN");
  });

  test("real LTT description: a 'Channel Partners' link list with no per-line sponsor keyword", () => {
    // The per-video sponsor mention here ("using our link", no "sponsor"
    // keyword) is a harder case we don't chase — but every LTT video also
    // carries this evergreen partners block, which is worth surfacing.
    const desc = [
      "Secure your business with ThreatLocker today using our link: https://www.threatlocker.com/ltt",
      "",
      "The AM4 platform refuses to die, spanning four generations of Zen processors.",
      "",
      "Check out our Channel Partners:",
      "Secretlab - Grab a TITAN Evo ergonomic gaming chair:  https://lmg.gg/secretlabltt",
      "PIA - Get the VPN of our choice: https://www.piavpn.com/ltt",
      'dbrand - Buy a "Circuit" series skin for your device: https://dbrand.com/pcb',
      "",
      "SHOP LTT PRODUCTS: https://lttstore.com",
    ].join("\n");
    const deals = detectDeals(desc);
    const partners = deals.filter((d) => d.context.startsWith("Secretlab") || d.context.startsWith("PIA") || d.context.startsWith("dbrand"));
    expect(partners.length).toBe(3);
    expect(partners.find((d) => d.context.startsWith("dbrand"))?.url).toBe("https://dbrand.com/pcb");
  });

  test("real MKBHD description: 'thanks X for sponsoring' with a discover link", () => {
    const desc =
      "Thanks Best Buy for sponsoring this video. You can find the tech upgrades you need to elevate your daily life at https://www.bestbuy.com/discover";
    const deals = detectDeals(desc);
    expect(deals.length).toBeGreaterThan(0);
    expect(deals[0].url).toBe("https://www.bestbuy.com/discover");
  });
});

describe("fetchRssXml retry", () => {
  test("retries through intermittent failures and eventually succeeds", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3 ? new Response("", { status: 404 }) : new Response("<feed></feed>", { status: 200 });
    }) as typeof fetch;
    try {
      const xml = await fetchRssXml("UCtest", { attempts: 6, baseDelayMs: 5 });
      expect(xml).toBe("<feed></feed>");
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("throws a descriptive error after exhausting all attempts", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await expect(fetchRssXml("UCtest", { attempts: 3, baseDelayMs: 5 })).rejects.toThrow(/Could not load/);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("normalizePhone", () => {
  test("accepts E.164", () => expect(normalizePhone("+14155552671")).toBe("+14155552671"));
  test("normalizes bare US 10-digit", () => expect(normalizePhone("415-555-2671")).toBe("+14155552671"));
  test("normalizes US with leading 1", () => expect(normalizePhone("1 (415) 555-2671")).toBe("+14155552671"));
  test("rejects garbage", () => expect(normalizePhone("hello")).toBeNull());
  test("rejects too-short numbers", () => expect(normalizePhone("12345")).toBeNull());
});

describe("maskPhone", () => {
  test("masks the middle digits", () => expect(maskPhone("+14155552671")).toBe("+1 ••• ••• 2671"));
});

describe("buildDealSms", () => {
  test("groups deals by video into one block", () => {
    const sms = buildDealSms([
      { channelName: "LTT", videoTitle: "A Video", videoUrl: "https://youtu.be/x", label: "Promo code", code: "LTT", dealUrl: "https://sponsor.com/ltt" },
      { channelName: "LTT", videoTitle: "A Video", videoUrl: "https://youtu.be/x", label: "Free trial", code: null, dealUrl: null },
    ]);
    expect(sms).toContain("Code LTT → https://sponsor.com/ltt");
    expect(sms).toContain("Free trial → https://youtu.be/x");
    expect(sms.split("🎯").length - 1).toBe(1);
  });

  test("returns empty string for no deals", () => {
    expect(buildDealSms([])).toBe("");
  });
});
