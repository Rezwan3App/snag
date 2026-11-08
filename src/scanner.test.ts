import { describe, expect, test } from "bun:test";
import { detectDeals, fetchRssXml, scanChannelAndSave, parseSubscriberCount, searchChannels } from "./scanner";
import { db } from "./db";
import { normalizePhone, maskPhone, buildDealSms, sendSms } from "./notify";

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

  test("finds the expiry even when 'by' appears much earlier in the description", () => {
    const deals = detectDeals(
      "Sponsored by Squarespace, the all-in-one platform for building a website from scratch. Use code LTT for 10% off. Offer ends December 25, 2026.",
    );
    expect(deals.find((d) => d.code === "LTT")?.expiresAt).toContain("2026-12-25");
  });

  test("a partner-list link can't carry quotes or tags into the deal URL", () => {
    const deals = detectDeals('Channel Partners:\nAcme - great stuff: https://acme.com/x"><svg/onload=alert(1)>\n');
    for (const d of deals) expect(d.url ?? "").not.toMatch(/["'<>]/);
  });
});

describe("detectDeals fixes", () => {
  test("lowercase word after 'code' is not a promo code", () => {
    expect(detectDeals("Use code below for 10% off").some((d) => d.code === "BELOW")).toBe(false);
  });
  test("'Use code: SAVE20' matches", () => {
    expect(detectDeals("Use code: SAVE20 for 20% off").some((d) => d.code === "SAVE20")).toBe(true);
  });
  test("'code SAVE20 at checkout' matches", () => {
    expect(detectDeals("Grab it, code SAVE20 at checkout").some((d) => d.code === "SAVE20")).toBe(true);
  });
  test("impossible date is not rolled into the next month", () => {
    const deals = detectDeals("Use code SAVE20 for 20% off. Offer ends Feb 30");
    expect(deals.every((d) => d.expiresAt === null)).toBe(true);
  });
  test("'friends' alone does not set an expiry", () => {
    const deals = detectDeals("Use code SAVE20 for 20% off, tell your friends");
    expect(deals.every((d) => d.expiresAt === null)).toBe(true);
  });
});

describe("fetchRssXml", () => {
  test("rejects a malformed channel id without making a request", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(fetchRssXml("abc&x=1")).rejects.toThrow(/Invalid channel id/);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("fetchRssXml retry", () => {
  test("retries through intermittent failures and eventually succeeds", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3 ? new Response("", { status: 404 }) : new Response("<feed></feed>", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const xml = await fetchRssXml("UCXuqSBlHAE6Xw-yeJA0Tunw", { attempts: 6, baseDelayMs: 5 });
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
    }) as unknown as typeof fetch;
    try {
      await expect(fetchRssXml("UCXuqSBlHAE6Xw-yeJA0Tunw", { attempts: 3, baseDelayMs: 5 })).rejects.toThrow(/Could not load/);
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

describe("sendSms", () => {
  test("stops sending real texts after the hourly cap", async () => {
    const realFetch = globalThis.fetch;
    const realEnv = { ...process.env };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15550000000" });
    try {
      for (let i = 0; i < 20; i++) expect((await sendSms("+14155552671", "hi")).ok).toBe(true);
      const blocked = await sendSms("+14155552671", "hi");
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/limit/);
      expect(calls).toBe(20);
    } finally {
      globalThis.fetch = realFetch;
      process.env = realEnv;
    }
  });

  test("truncates the body to Twilio's 1600 char limit", async () => {
    const realFetch = globalThis.fetch;
    const realEnv = { ...process.env };
    let sent = "";
    globalThis.fetch = (async (_u: string, init: any) => {
      sent = new URLSearchParams(init.body).get("Body")!;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15550000000", SMS_MAX_PER_HOUR: "1000" });
    try {
      await sendSms("+14155552671", "x".repeat(3000));
      expect(sent.length).toBe(1600);
    } finally {
      globalThis.fetch = realFetch;
      process.env = realEnv;
    }
  });
});

describe("scanChannelAndSave texting", () => {
  // Shared singleton db; server.test.ts (runs last) closes and deletes it.
  process.env.SNAG_DB_PATH ??= `./snag.shared.test.${process.pid}.db`;

  const CH = "UCXuqSBlHAE6Xw-yeJA0Tunw";
  const entry = (id: string, desc: string) =>
    `<entry><yt:videoId>${id}</yt:videoId><title>T ${id}</title><media:description>${desc}</media:description><published>2026-01-01T00:00:00Z</published></entry>`;
  const feed = (...entries: string[]) => `<feed><title>Chan</title>${entries.join("")}</feed>`;

  // Mocks YouTube RSS and Twilio; returns the bodies of texts sent.
  async function run(xml: string, twilioStatus = 201) {
    const realFetch = globalThis.fetch;
    const realEnv = { ...process.env };
    const texts: string[] = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      if (String(url).includes("twilio.com")) {
        texts.push(new URLSearchParams(init.body).get("Body")!);
        return new Response("{}", { status: twilioStatus });
      }
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC_t", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15550000000", SMS_MAX_PER_HOUR: "1000" });
    try {
      const result = await scanChannelAndSave(CH, "Chan", 5);
      return { result, texts };
    } finally {
      globalThis.fetch = realFetch;
      process.env = realEnv;
    }
  }

  const partners = "Check out our Channel Partners:\nPIA - VPN: https://www.piavpn.com/ltt\n";

  test("same sponsor list on several videos and later uploads is texted once, but all saved", async () => {
    db.setSubscriber("+14155552671");
    const first = await run(feed(entry("a1", partners), entry("a2", partners), entry("a3", partners)));
    expect(first.texts.length).toBe(1);
    expect(first.result.newDeals).toBe(3);

    const second = await run(feed(entry("a4", partners), entry("a1", partners)));
    expect(second.texts.length).toBe(0);
    expect(second.result.newDeals).toBe(1);
  });

  test("expired deals are saved but not texted", async () => {
    const { texts, result } = await run(feed(entry("b1", "Use code OLDONE for 10% off. Offer ends January 1, 2020.")));
    expect(texts.length).toBe(0);
    expect(result.newDeals).toBeGreaterThan(0);
  });

  test("a failed text un-saves the deals so the next scan retries", async () => {
    const xml = feed(entry("c1", "Use code RETRY1 for 10% off"));
    const failed = await run(xml, 500);
    expect(failed.texts.length).toBe(1);
    expect(failed.result.newDeals).toBe(0);
    expect(db.getDeals().some((d) => d.code === "RETRY1")).toBe(false);

    const retry = await run(xml);
    expect(retry.texts.length).toBe(1);
    expect(retry.texts[0]).toContain("RETRY1");
describe("parseSubscriberCount", () => {
  test("parses suffixes and edge cases", () => {
    expect(parseSubscriberCount("21.4M subscribers")).toBe(21400000);
    expect(parseSubscriberCount("46 subscribers")).toBe(46);
    expect(parseSubscriberCount("1.2K")).toBe(1200);
    expect(parseSubscriberCount("1 subscriber")).toBe(1);
    expect(parseSubscriberCount("No subscribers")).toBe(0);
    expect(parseSubscriberCount("")).toBe(0);
    expect(parseSubscriberCount("@mkbhd")).toBe(0);
  });
});

describe("searchChannels ranking", () => {
  test("big channel first, tiny impostor dropped", async () => {
    const mk = (channelId: string, title: string, handle: string, subs: string) => ({
      channelRenderer: {
        channelId,
        title: { simpleText: title },
        subscriberCountText: { simpleText: handle },
        videoCountText: { simpleText: subs },
        thumbnail: { thumbnails: [{ url: "//img/x.jpg" }] },
      },
    });
    const data = {
      contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
        { itemSectionRenderer: { contents: [
          mk("UCfake", "MKBHD", "@fake", "46 subscribers"),
          mk("UCreal", "Marques Brownlee", "@mkbhd", "21.4M subscribers"),
        ] } },
      ] } } } },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`)) as unknown as typeof fetch;
    try {
      const r = await searchChannels("MKBHD");
      expect(r.map((x) => x.id)).toEqual(["UCreal"]);
      expect(r[0].subscribers).toBe("21.4M subscribers");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
