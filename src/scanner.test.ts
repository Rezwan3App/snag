import { describe, expect, test } from "bun:test";
import { detectDeals } from "./scanner";
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
