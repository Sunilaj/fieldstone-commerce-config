// @vitest-environment node
/**
 * Fieldstone's loyalty service.
 *
 * The happy path is small: points in, points out. What is worth testing is
 * everything this service refuses, because it is the thing that decides how
 * much less a shopper pays and it is reached over the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock("../src/platform.js", () => ({ verifyPlatformCall: verifyMock }));

/*
  What Fieldstone's own deployment holds, and nothing the platform keeps for
  them: the secret the platform issued when they registered the webhook, and
  which shop this instance serves. The service reads both from the environment
  — a webhook payload carries no tenant — so both belong here.
*/
const WEBHOOK_SECRET = "test-webhook-secret";
const TENANT = "t-fieldstone";

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rewards-"));
  process.env.REWARDS_LEDGER = join(dir, "ledger.json");
  process.env.FCC_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FCC_TENANT_ID = TENANT;
  vi.resetModules();
  verifyMock.mockResolvedValue({ tenantId: TENANT, scopes: ["checkout:offer"] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function app() {
  return (await import("../src/index.js")).default;
}

const call = async (path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer tok" }) =>
  (await app()).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/*
  A webhook is SIGNED, not bearer-authenticated.

  This suite posted a bearer token and no signature, which is not a request the
  platform has ever made. Every delivery was answered 401, every balance stayed
  at zero, and the thirteen tests below that begin by buying something were
  asserting against a shopper who had never earned a point.
*/
const sign = (raw: string) =>
  `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(raw, "utf8").digest("hex")}`;

/** Pass `signature` to send a bad one; pass `""` to send none at all. */
const hook = async (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  const signed = signature === undefined ? sign(raw) : signature;
  return (await app()).request("/hooks/fcc", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signed ? { "x-fcc-signature": signed } : {}) },
    body: raw,
  });
};

/*
  `order.created`, with `totalAmount` in RUPEES — the event the platform emits
  and the field it carries. This helper sent `order.placed` with `totalMinor`,
  neither of which the platform sends, so every amount below was also being
  read in the wrong unit once 1573c74 named it.
*/
const order = (id: string, totalAmount: number, customerId = "shopper-1") => ({
  event: "order.created",
  data: { orderId: id, customerId, totalAmount },
});

describe("earning", () => {
  it("awards a point per ten rupees on a paid order", async () => {
    // ₹2,400 spent, 240 points — ten per cent back, which is the whole scheme.
    const res = await hook(order("o1", 2_400));
    expect(await res.json()).toMatchObject({ ok: true, points: 240 });
  });

  it("does not award twice for the same order, because webhooks retry", async () => {
    await hook(order("o1", 2_400));
    const again = await hook(order("o1", 2_400));
    expect(await again.json()).toMatchObject({ duplicate: true });
  });

  it("ignores an event it was not built for", async () => {
    const res = await hook({ event: "order.cancelled", data: {} });
    expect(await res.json()).toMatchObject({ ignored: "order.cancelled" });
  });

  it("refuses an unsigned webhook — this is money", async () => {
    /*
      This asked `verifyPlatformCall` to return null, which `/hooks/fcc` never
      calls: it passed because NOTHING was signed, and it would have gone on
      passing if the signature check were deleted outright. Both halves of the
      real refusal are checked now — no signature at all, and one computed with
      somebody else's secret.
    */
    const body = order("o1", 1_000);
    expect((await hook(body, "")).status).toBe(401);
    const forged = `sha256=${createHmac("sha256", "not-our-secret").update(JSON.stringify(body), "utf8").digest("hex")}`;
    expect((await hook(body, forged)).status).toBe(401);
  });
});

describe("offering", () => {
  const basket = { shopperId: "shopper-1", subtotalMinor: 500_00, currency: "INR" };

  it("offers nothing to a shopper with too few points", async () => {
    await hook(order("o1", 500));   // ₹500 is 50 points, below the floor
    expect(await (await call("/checkout/offers", basket)).json()).toEqual({ offers: [] });
  });

  it("offers a redemption once there are enough", async () => {
    await hook(order("o1", 2_400));  // 240 points
    const [offer] = (await (await call("/checkout/offers", basket)).json()).offers;
    expect(offer).toMatchObject({ label: "Redeem 200 points", discountMinor: 200_00, currency: "INR" });
  });

  it("never offers more than the basket is worth", async () => {
    await hook(order("o1", 50_000)); // 5000 points
    const [offer] = (await (await call("/checkout/offers", { ...basket, subtotalMinor: 300_00 })).json()).offers;
    // The platform caps this too — but a service that relies on being corrected
    // is wrong the day the correction moves.
    expect(offer.discountMinor).toBeLessThanOrEqual(300_00);
  });

  it("refuses a request about a tenant the token was not issued for", async () => {
    const res = await call("/checkout/offers", { ...basket, tenantId: "somebody-else" });
    expect(res.status).toBe(403);
  });

  it("refuses an unsigned request", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/checkout/offers", basket)).status).toBe(401);
  });
});

describe("redeeming, which is the binding half", () => {
  const basket = { shopperId: "shopper-1", subtotalMinor: 500_00, currency: "INR" };

  async function offered() {
    await hook(order("o1", 2_400));
    const [offer] = (await (await call("/checkout/offers", basket)).json()).offers;
    return offer.id as string;
  }

  it("takes the points out of the ledger, once", async () => {
    const offerId = await offered();
    const first = await (await call("/checkout/redeem", { offerId, ...basket })).json();
    expect(first).toMatchObject({ ok: true, discountMinor: 200_00 });

    /*
      The same offer, refused because it has been USED — not because the
      balance happens to have fallen below it. The first version of this test
      gave the shopper 240 points against a 200-point offer, so the second
      attempt failed for lack of points and single-use was never exercised;
      running the real flow with a 4,000-point balance spent it twice.
    */
    const second = await (await call("/checkout/redeem", { offerId, ...basket })).json();
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already been applied/i);
  });

  it("is single-use even when the shopper has plenty of points left", async () => {
    // The case the original test could not see: a large balance, so the second
    // attempt cannot be refused for affordability.
    await hook(order("big", 40_000));
    const [offer] = (await (await call("/checkout/offers", basket)).json()).offers;
    expect((await (await call("/checkout/redeem", { offerId: offer.id, ...basket })).json()).ok).toBe(true);
    const again = await (await call("/checkout/redeem", { offerId: offer.id, ...basket })).json();
    expect(again.ok, "the same reward was applied twice").toBe(false);
  });

  it("refuses an offer belonging to another shopper", async () => {
    const offerId = await offered();
    const res = await (await call("/checkout/redeem", { offerId, shopperId: "shopper-2", subtotalMinor: 500_00 })).json();
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/does not belong/);
  });

  it("refuses a forged offer id", async () => {
    const res = await (await call("/checkout/redeem", { offerId: "redeem:shopper-1:999999", ...basket })).json();
    expect(res.ok).toBe(false);
  });

  it("refuses an unsigned redemption", async () => {
    const offerId = await offered();
    verifyMock.mockResolvedValue(null);
    expect((await call("/checkout/redeem", { offerId, ...basket })).status).toBe(401);
  });
});

describe("deciding whether an order may proceed at all", () => {
  it("allows an ordinary basket", async () => {
    const res = await (await call("/order/validate", { subtotalMinor: 4_000_00, shopperId: "shopper-1" })).json();
    expect(res).toEqual({ decision: "allow", reason: null });
  });

  it("sends a large one to the trade desk, with a reason a shopper can read", async () => {
    const res = await (await call("/order/validate", { subtotalMinor: 60_000_00, shopperId: "shopper-1" })).json();
    expect(res.decision).toBe("block");
    // Not a rule code. The platform passes this straight to the shopper.
    expect(res.reason).toMatch(/trade desk/i);
    expect(res.reason).toMatch(/nothing has been charged/i);
  });

  it("refuses to decide for an unsigned caller", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/order/validate", { subtotalMinor: 60_000_00 })).status).toBe(401);
  });

  it("allows when it cannot tell — a bug here must not stop Fieldstone selling", async () => {
    const res = await (await call("/order/validate", {})).json();
    expect(res.decision).toBe("allow");
  });
});

describe("what one tenant can see of another", () => {
  it("balances are scoped to the tenant in the token", async () => {
    await hook(order("o1", 5_000));  // 500 points, so "none of them" means something
    verifyMock.mockResolvedValue({ tenantId: "a-different-tenant", scopes: [] });
    const res = await (await call("/checkout/offers", { shopperId: "shopper-1", subtotalMinor: 500_00, currency: "INR" })).json();
    // The same shopper id, a different tenant, and none of the points.
    expect(res).toEqual({ offers: [] });
  });
});

/*
  The five points added after "three hooks for a platform this powerful,
  seriously?". Each one is tested for the thing that would actually go wrong:
  not that it answers, but that it refuses what it says it refuses, and that an
  unsigned caller gets nothing at all.
*/

/** Earn a balance the way a shopper would: by buying something. */
const earn = (points: number, shopperId = "shopper-1") =>
  hook(order(`o-${shopperId}-${points}`, points * 10, shopperId));

describe("badging a product", () => {
  it("says what a product earns, for every sku asked about", async () => {
    const res = await call("/product/badge", { skus: ["TOOL-1", "TOOL-2"], shopperId: null });
    const { badges } = await res.json() as { badges: Array<{ sku: string; label: string }> };
    expect(badges.map((b) => b.sku)).toEqual(["TOOL-1", "TOOL-2"]);
    expect(badges[0].label).toMatch(/points/i);
  });

  it("calls out the categories Fieldstone doubles", async () => {
    const res = await call("/product/badge", { skus: ["GARD-9"], shopperId: null });
    const { badges } = await res.json() as { badges: Array<{ label: string; tone: string }> };
    expect(badges[0].label).toMatch(/double/i);
    expect(badges[0].tone).toBe("warning");
  });

  it("badges nothing when asked about nothing", async () => {
    const res = await call("/product/badge", { skus: [], shopperId: "shopper-1" });
    expect(await res.json()).toEqual({ badges: [] });
  });

  it("refuses an unsigned caller — a badge is still a claim made in our name", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/product/badge", { skus: ["TOOL-1"] })).status).toBe(401);
  });
});

describe("member pricing", () => {
  it("offers nothing to somebody with no standing", async () => {
    const res = await call("/cart/price", { shopperId: "nobody", lines: [{ sku: "A", unitPriceMinor: 10_000 }] });
    expect(await res.json()).toEqual({ lines: [] });
  });

  it("prices down for a Gold member, and never up", async () => {
    await earn(1_500);
    const res = await call("/cart/price", { shopperId: "shopper-1", lines: [{ sku: "A", unitPriceMinor: 10_000 }] });
    const { lines } = await res.json() as { lines: Array<{ unitPriceMinor: number; reason: string }> };
    expect(lines[0].unitPriceMinor).toBe(9_500);
    expect(lines[0].unitPriceMinor).toBeLessThan(10_000);
    expect(lines[0].reason).toMatch(/Gold/);
  });

  it("gives a Trade member the deeper rate", async () => {
    await earn(6_000, "trade-1");
    const res = await call("/cart/price", { shopperId: "trade-1", lines: [{ sku: "A", unitPriceMinor: 10_000 }] });
    const { lines } = await res.json() as { lines: Array<{ unitPriceMinor: number }> };
    expect(lines[0].unitPriceMinor).toBe(9_000);
  });

  it("skips a line with no price rather than inventing one", async () => {
    await earn(1_500);
    const res = await call("/cart/price", { shopperId: "shopper-1", lines: [{ sku: "A" }] });
    expect(await res.json()).toEqual({ lines: [] });
  });

  it("refuses an unsigned caller — this decides what somebody is charged", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/cart/price", { shopperId: "x", lines: [] })).status).toBe(401);
  });
});

describe("delivery by our own vans", () => {
  it("charges a guest for the Saturday slot", async () => {
    const res = await call("/checkout/fulfilment", { shopperId: null, subtotalMinor: 100_000 });
    const { options } = await res.json() as { options: Array<{ id: string; surchargeMinor: number }> };
    expect(options.find((o) => o.id === "sat-am")!.surchargeMinor).toBe(25_00);
  });

  it("gives it to a member for nothing", async () => {
    await earn(1_500);
    const res = await call("/checkout/fulfilment", { shopperId: "shopper-1", subtotalMinor: 100_000 });
    const { options } = await res.json() as { options: Array<{ id: string; surchargeMinor: number; label: string }> };
    const sat = options.find((o) => o.id === "sat-am")!;
    expect(sat.surchargeMinor).toBe(0);
    expect(sat.label).toMatch(/free/i);
  });

  it("never charges more for delivery than the basket is worth", async () => {
    const res = await call("/checkout/fulfilment", { shopperId: null, subtotalMinor: 500 });
    const { options } = await res.json() as { options: Array<{ id: string; surchargeMinor: number }> };
    expect(options.find((o) => o.id === "sat-am")!.surchargeMinor).toBeLessThanOrEqual(500);
  });

  it("refuses an unsigned caller", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/checkout/fulfilment", { subtotalMinor: 1 })).status).toBe(401);
  });
});

describe("merchandising", () => {
  it("puts bonus-earning stock first", async () => {
    const res = await call("/search/rerank", { query: "bench", skus: ["TOOL-1", "GARD-2", "TOOL-3", "PAV-4"] });
    expect(await res.json()).toEqual({ skus: ["GARD-2", "PAV-4", "TOOL-1", "TOOL-3"] });
  });

  it("returns every sku it was given — hiding stock is not merchandising", async () => {
    const sent = ["TOOL-1", "GARD-2", "TOOL-3", "PAV-4", "OUT-5"];
    const res = await call("/search/rerank", { query: "x", skus: sent });
    const { skus } = await res.json() as { skus: string[] };
    expect([...skus].sort()).toEqual([...sent].sort());
  });

  it("adds nothing of its own", async () => {
    const res = await call("/search/rerank", { query: "x", skus: ["TOOL-1"] });
    const { skus } = await res.json() as { skus: string[] };
    expect(skus).toEqual(["TOOL-1"]);
  });

  it("refuses an unsigned caller", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/search/rerank", { skus: [] })).status).toBe(401);
  });
});

describe("enriching a paid order", () => {
  it("attaches the tier and what the order earned", async () => {
    await earn(1_500);
    /*
      `order.enrich` is sent `totalMinor`, in PAISE — the webhook is sent
      `totalAmount`, in rupees. That is the disagreement 1573c74 named, and it
      is why the same ₹400 is written two ways in this file. ₹400 earns 40
      points, not 400: this expectation was written when a point cost a rupee
      and it outlived the scheme it described.
    */
    const res = await call("/order/enrich", { orderId: "ORD-1", shopperId: "shopper-1", totalMinor: 400_00 });
    const { attributes } = await res.json() as { attributes: Record<string, string> };
    expect(attributes).toMatchObject({ loyaltyScheme: "Fieldstone Rewards", memberTier: "Gold", pointsEarned: "40" });
    // Every value a string: the platform stores these as text and a number
    // here would come back as one shape on write and another on read.
    for (const v of Object.values(attributes)) expect(typeof v).toBe("string");
  });

  it("attaches nothing for a guest, rather than inventing a member", async () => {
    const res = await call("/order/enrich", { orderId: "ORD-2", shopperId: null, totalMinor: 40_000 });
    expect(await res.json()).toEqual({ attributes: {} });
  });

  it("refuses an unsigned caller", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/order/enrich", { orderId: "x" })).status).toBe(401);
  });
});

/*
  The UI slots. What a shopper is TOLD, beside the hooks that decide what they
  are charged — and until these existed we could change somebody's total and had
  no way to render the sentence explaining it.

  We never send code or markup; the platform draws a short description in the
  shop's own theme. So these cases are about whether we say the right thing to
  the right person, not about how it looks.
*/
describe("what a shopper is told on a product page", () => {
  it("says a product earns points, and calls out the ones that earn double", async () => {
    const plain = await (await call("/ui/product-panel", { sku: "TOOL-1", shopperId: null })).json() as { elements: Array<{ label?: string }> };
    expect(plain.elements[0].label).toMatch(/earns points/i);

    const bonus = await (await call("/ui/product-panel", { sku: "GARD-9", shopperId: null })).json() as { elements: Array<{ label?: string }> };
    expect(bonus.elements[0].label).toMatch(/double/i);
  });

  it("tells a member what THEY pay, and a guest nothing about tiers", async () => {
    await earn(1_500);
    const member = await (await call("/ui/product-panel", { sku: "TOOL-1", shopperId: "shopper-1" })).json() as { elements: Array<{ text?: string }> };
    expect(member.elements.some((e) => /Gold members pay 5% less/.test(e.text ?? ""))).toBe(true);

    const guest = await (await call("/ui/product-panel", { sku: "TOOL-1", shopperId: null })).json() as { elements: unknown[] };
    expect(guest.elements.length).toBe(1);
  });

  it("says nothing at all when the platform names no product", async () => {
    expect(await (await call("/ui/product-panel", { shopperId: "shopper-1" })).json()).toEqual({ elements: [] });
  });

  it("refuses an unsigned caller — this renders in somebody's shop under our name", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/ui/product-panel", { sku: "TOOL-1" })).status).toBe(401);
  });
});

describe("what a shopper is told about their basket", () => {
  it("says how far they are from the next tier", async () => {
    await earn(400);
    const body = await (await call("/ui/cart-summary", { shopperId: "shopper-1" })).json() as { elements: Array<{ text: string }> };
    expect(body.elements[0].text).toMatch(/600 more to reach Gold/);
  });

  it("says something useful once they are past it, rather than a negative number", async () => {
    await earn(1_500);
    const body = await (await call("/ui/cart-summary", { shopperId: "shopper-1" })).json() as { elements: Array<{ text: string; tone: string }> };
    expect(body.elements[0].text).not.toMatch(/-/);
    expect(body.elements[0].tone).toBe("success");
  });

  it("says nothing to a guest, who has no standing to report", async () => {
    expect(await (await call("/ui/cart-summary", { shopperId: null })).json()).toEqual({ elements: [] });
  });
});

describe("what a shopper sees on their own account page", () => {
  it("shows the balance, the tier, and the entries that explain it", async () => {
    /*
      "Why do I have 240 points" is the whole of loyalty support, and it is
      answerable only because the ledger is append-only. A cached counter would
      give the number and none of the reasons.
    */
    await earn(1_500);
    const body = await (await call("/ui/account-panel", { shopperId: "shopper-1" })).json() as {
      elements: Array<{ type: string; value?: string; caption?: string; items?: string[] }>;
    };
    const stat = body.elements.find((e) => e.type === "stat")!;
    expect(stat.value).toMatch(/1,500/);
    expect(stat.caption).toBe("Gold");
    expect(body.elements.find((e) => e.type === "list")!.items!.length).toBeGreaterThan(0);
  });

  it("shows a shopper with no points that they are not a member yet", async () => {
    const body = await (await call("/ui/account-panel", { shopperId: "nobody" })).json() as {
      elements: Array<{ caption?: string }>;
    };
    expect(body.elements[0].caption).toMatch(/not a member/i);
  });

  it("never sends more entries than the slot will render", async () => {
    // The platform caps this too. A service that relies on being corrected is
    // wrong the day the correction moves.
    for (let i = 0; i < 12; i++) await earn(10 + i, "busy-1");
    const body = await (await call("/ui/account-panel", { shopperId: "busy-1" })).json() as {
      elements: Array<{ type: string; items?: string[] }>;
    };
    expect(body.elements.find((e) => e.type === "list")!.items!.length).toBeLessThanOrEqual(5);
  });

  it("refuses an unsigned caller", async () => {
    verifyMock.mockResolvedValue(null);
    expect((await call("/ui/account-panel", { shopperId: "shopper-1" })).status).toBe(401);
  });
});
