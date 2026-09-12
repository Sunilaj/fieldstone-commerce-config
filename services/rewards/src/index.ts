/**
 * Fieldstone Rewards — a loyalty scheme Fieldstone built on the platform's APIs.
 *
 * Not part of Flipkart Commerce Cloud. See README.md for why that distinction
 * is the entire point of this service existing.
 *
 * One event, seven hooks, and a door of its own:
 *
 *   POST /hooks/fcc            EVENT. An order was paid → earn. Retried, and
 *                              our answer is ignored, which is what makes it
 *                              an event and not a hook.
 *
 *   POST /product/badge        what does this earn?
 *   POST /search/rerank        our shelves, in our order
 *   POST /cart/price           what this member pays
 *   POST /checkout/offers      what can come off this basket?
 *   POST /checkout/fulfilment  our own vans
 *   POST /order/validate       may this be charged at all?
 *   POST /checkout/redeem      the shopper took the offer; is it still good?
 *   POST /order/enrich         what our back office needs on the order
 *
 *   GET  /points               Fieldstone's own staff look a shopper up.
 *                              Not called by the platform.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { balance, history, ledger, record, spent } from "./points.js";
import { verifyPlatformCall } from "./platform.js";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = new Hono();

/*
  Ten points per hundred rupees. Fieldstone's rule, and nobody else's.

  It was one, which sounded generous and was not: a thousand points bought
  Gold, so Gold began at a hundred thousand rupees of spending. Nobody reached
  it. Every shopper we have ever had sat at Member with no discount, which
  means the tiers — the whole of what makes this a loyalty scheme rather than a
  coupon — have never once applied to anybody.
*/
const POINTS_PER_MAJOR_UNIT = 10;
/** What a point is worth when spent, in minor units. 100 points = ₹100. */
const MINOR_UNITS_PER_POINT = 100;
/**
 * The smallest redemption worth offering.
 *
 * Was a hundred points — a hundred rupees off, after ten thousand rupees of
 * spending. Nobody reached it: every shopper who earned anything earned less
 * than the floor, so the offer we built has never once been shown at a
 * checkout. A scheme whose reward is unreachable is a scheme nobody is in.
 */
const MIN_REDEEMABLE = 100;

/**
 * SKU prefixes Fieldstone gives double points on.
 *
 * Fieldstone's merchandising decision, expressed as data rather than a rule
 * engine, because it is one line of one retailer's opinion and belongs in the
 * service that holds that opinion.
 */
const BONUS_CATEGORIES = ["GARD", "PAV", "OUT"];

/**
 * A member's standing, derived from the ledger.
 *
 * Derived rather than stored: a tier is a fact ABOUT a balance, and two places
 * holding it means one of them is wrong after the next purchase.
 */
async function tierFor(token: string | null, tenantId: string, shopperId: string): Promise<{ name: string; discountPercent: number } | null> {
  const points = await balance(token, tenantId, shopperId);
  /*
    Thresholds a customer reaches inside a year, not a decade.

    At ten points per hundred rupees these are roughly ten thousand and forty
    thousand rupees of spending — a regular customer and a trade buyer, which
    is what the two names were always supposed to mean.
  */
  if (points >= 4_000) return { name: "Trade", discountPercent: 10 };
  if (points >= 1_000) return { name: "Gold", discountPercent: 5 };
  if (points > 0) return { name: "Member", discountPercent: 0 };
  return null;
}

/**
 * Health, including the store.
 *
 * This answered `{ ok: true }` without touching anything, so a Fieldstone with
 * an unreachable database reported itself healthy right up until a shopper
 * tried to redeem. A loyalty service whose ledger is gone is not healthy; it is
 * a service that will shortly tell somebody their points do not exist.
 */
app.get("/health", async (c) => {
  try {
    await ledger().check();
  } catch (e) {
    return c.json({ ok: false, service: "fieldstone-rewards", store: e instanceof Error ? e.message : "unreachable" }, 503);
  }
  return c.json({ ok: true, service: "fieldstone-rewards", store: "ready" });
});

/**
 * An order was paid. Award points.
 *
 * Idempotent on the order id: the platform's webhook fabric retries, and a
 * scheme that awarded points twice for one delivery attempt would be a scheme
 * its own customers could farm.
 */
/**
 * Whether a webhook really came from the platform.
 *
 * A webhook is SIGNED, not bearer-authenticated. This route asked for an
 * `Authorization` header the platform has never sent — it sends
 * `X-FCC-Signature: sha256=<hmac of the body, with our endpoint secret>` — so
 * every delivery we have ever been sent was answered 401 and every retry after
 * it. The deliveries are in their log as failures; no points were ever awarded.
 *
 * Compared in constant time. A signature check that returns on the first wrong
 * byte can be guessed one byte at a time.
 */
function signedByPlatform(raw: string, header: string | undefined): boolean {
  const secret = process.env.FCC_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post("/hooks/fcc", async (c) => {
  const raw = await c.req.text();
  if (!signedByPlatform(raw, c.req.header("x-fcc-signature"))) {
    return c.json({ error: "unsigned" }, 401);
  }
  const token = null;

  const body = JSON.parse(raw || "{}") as {
    /* The platform's field is `event`. We read `type` for years, which is not
       a field it has ever sent, so every payload looked like an event we did
       not recognise. */
    event?: string;
    type?: string;
    /* `totalAmount` is the platform's name for it. We read `totalMinor`,
       which it does not send, so every order arrived looking as though it had
       no total and was refused 400. */
    data?: { orderId?: string; customerId?: string; totalAmount?: number; totalMinor?: number };
  };
  const kind = body.event ?? body.type ?? "";

  /* Our tenant, from our own deployment.
     A webhook payload carries no tenant — correctly, since this endpoint was
     registered by one shop and receives only that shop's events. */
  const tenantId = process.env.FCC_TENANT_ID;
  if (!tenantId) return c.json({ error: "FCC_TENANT_ID is not set on this deployment" }, 500);
  /*
    `order.created` is what the platform actually emits.

    This listened for `order.placed`, which reads better and does not exist —
    so every order we have ever been sent was answered `{ ignored }` and nobody
    has earned a point since we shipped. Nothing failed: the delivery
    succeeded, we returned 200, and the balance stayed at zero.

    `order.placed` is still accepted, because it costs one line and an event
    name is the platform's to choose, not ours to be brittle about.
  */
  const EARNING_EVENTS = ["order.created", "order.placed"];
  if (!EARNING_EVENTS.includes(kind)) return c.json({ ignored: kind || null });

  const { orderId, customerId } = body.data ?? {};
  const totalMinor = body.data?.totalAmount ?? body.data?.totalMinor;
  if (!orderId || !customerId || !Number.isFinite(totalMinor)) {
    return c.json({ error: `${kind} without an order, a customer or a total` }, 400);
  }

  const ref = `order:${orderId}`;
  const points = Math.floor((totalMinor! / 100) * POINTS_PER_MAJOR_UNIT);
  if (points <= 0) return c.json({ ok: true, points: 0 });

  /*
    Idempotence decided by the WRITE, not by a read before it.

    This asked `alreadyRecorded(ref)` first and then wrote. Two retries arriving
    together both read "not recorded" and both awarded — which for a retrying
    webhook fabric is not a hypothetical. The unique index on `ref` makes the
    second write lose, and losing is reported as a duplicate rather than an error
    because a retry of something already honoured is a success.
  */
  const written = await record(token, { tenantId, shopperId: customerId, points, reason: "Order paid", ref });
  if (!written.written) return c.json({ ok: true, duplicate: true });
  return c.json({ ok: true, points });
});

/**
 * What this basket can have off.
 *
 * A quotation, not a commitment — see `/checkout/redeem`. Only ever one offer:
 * a wall of redemption tiers at the moment somebody is trying to pay is a way
 * to lose the sale.
 */
app.post("/checkout/offers", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { shopperId, subtotalMinor, currency, tenantId } = await c.req.json().catch(() => ({})) as {
    shopperId?: string; subtotalMinor?: number; currency?: string; tenantId?: string;
  };

  /*
    The tenant in the TOKEN, not the one in the body. The body is data; the
    token is the platform's word. A mismatch means somebody is asking about a
    tenant they were not issued a token for.
  */
  if (tenantId && tenantId !== caller.tenantId) return c.json({ error: "tenant mismatch" }, 403);
  if (!shopperId) return c.json({ offers: [] });

  const points = await balance(token, caller.tenantId, shopperId);
  if (points < MIN_REDEEMABLE) return c.json({ offers: [] });

  /*
    Never more than the basket. The platform caps this again on its side — and
    it should, because it cannot know this service is well behaved — but a
    service that relies on being corrected is a service that will be wrong the
    day the correction moves.
  */
  const spendable = Math.min(
    Math.floor(points / MIN_REDEEMABLE) * MIN_REDEEMABLE,
    Math.floor((subtotalMinor ?? 0) / MINOR_UNITS_PER_POINT),
  );
  if (spendable < MIN_REDEEMABLE) return c.json({ offers: [] });

  const discountMinor = spendable * MINOR_UNITS_PER_POINT;
  return c.json({
    offers: [{
      id: `redeem:${shopperId}:${spendable}`,
      label: `Redeem ${spendable} points`,
      detail: `You have ${points}. Spending ${spendable} takes ${(discountMinor / 100).toFixed(0)} off.`,
      discountMinor,
      currency: currency ?? "INR",
    }],
  });
});

/**
 * Binding. The points come out of the ledger here and nowhere else.
 *
 * Re-checked against the CURRENT balance rather than the quoted one: between
 * the offer and this call the shopper may have spent the same points on another
 * order, in another tab. Refusing is the correct answer and the platform is
 * built to hear it.
 */
app.post("/checkout/redeem", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { offerId, shopperId, subtotalMinor } = await c.req.json().catch(() => ({})) as {
    offerId?: string; shopperId?: string; subtotalMinor?: number;
  };
  if (!offerId || !shopperId) return c.json({ ok: false, reason: "No offer named." });

  const [, offerShopper, rawPoints] = offerId.split(":");
  const points = Number(rawPoints);
  if (offerShopper !== shopperId || !Number.isFinite(points) || points <= 0) {
    return c.json({ ok: false, reason: "That offer does not belong to this shopper." });
  }

  /*
    An offer is spendable ONCE.

    Found by running the whole flow rather than by a unit test: a shopper with
    4,000 points redeemed the same 1,000-point offer twice, because the only
    check was "do they still have the points" — and after the first burn they
    did. A retried checkout, a double-clicked Pay, or a replayed request would
    have spent the balance in thousand-point slices.

    The unit test that was supposed to catch this passed for the wrong reason:
    its shopper held 240 points and the offer was 200, so the second attempt
    was refused for lack of points and the assertion never exercised
    single-use at all.
  */
  /*
    Asked first so the shopper is told the TRUE reason.

    This is not what makes the offer single-use — the unique `ref` on the write
    below is, and it is the only version that holds when two requests arrive
    together. But without this read the affordability check answers first, and
    somebody who re-submitted a used offer was told their points were "no longer
    available" when they were sitting right there. The right refusal, with the
    wrong explanation, is a support call.
  */
  if (await spent(token, shopperId, `spend:${offerId}`)) {
    return c.json({ ok: false, reason: "That reward has already been applied to an order." });
  }

  const held = await balance(token, caller.tenantId, shopperId);
  if (held < points) {
    return c.json({
      ok: false,
      reason: `Those points are no longer available — ${held} left, and this needed ${points}.`,
    });
  }

  const discountMinor = Math.min(points * MINOR_UNITS_PER_POINT, subtotalMinor ?? Number.MAX_SAFE_INTEGER);
  const ref = `spend:${offerId}`;
  /*
    Single-use, and the WRITE is what decides it.

    An offer was double-spent end to end once. The fix then was to check
    `alreadyRecorded("spend:" + offerId)` before writing — correct sequentially
    and still racy: a double-clicked Pay puts two requests in flight, both read
    an unspent offer, and both burn. The unique `ref` lets exactly one win, and
    the loser is told the truth rather than charged for it.
  */
  const written = await record(token, { tenantId: caller.tenantId, shopperId, points: -points, reason: "Redeemed at checkout", ref });
  if (!written.written) {
    return c.json({ ok: false, reason: "That reward has already been applied to an order." });
  }

  return c.json({ ok: true, discountMinor, reference: ref });
});

/**
 * May this order be charged?
 *
 * Fieldstone's rule, not the platform's: garden goods over a ceiling go to a
 * person first, because a fifty-thousand-rupee order of paving is either a
 * trade customer they want to call or a card they want to check. No commerce
 * platform should ship that opinion; this is where it belongs.
 *
 * Allowing is the default here as well as on the platform's side. A bug in this
 * function must not be able to stop Fieldstone selling.
 */
app.post("/order/validate", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { subtotalMinor, shopperId } = await c.req.json().catch(() => ({})) as {
    subtotalMinor?: number; shopperId?: string | null;
  };

  const ceiling = Number(process.env.REWARDS_REVIEW_CEILING_MINOR ?? 50_000_00);
  if (Number.isFinite(subtotalMinor) && (subtotalMinor as number) > ceiling) {
    /*
      A reason the SHOPPER reads. The platform passes it straight through to
      them, so "RULE_4417" would be a dead end — and an extension that blocks
      without a reason is treated as allowing, deliberately.
    */
    return c.json({
      decision: "block",
      reason:
        `Orders over ${(ceiling / 100).toLocaleString("en-IN")} are confirmed by our trade desk first. ` +
        `We will call you today — nothing has been charged.`,
    });
  }

  // A known shopper, or a basket under the ceiling: Fieldstone has no objection.
  void shopperId;
  return c.json({ decision: "allow", reason: null });
});

/**
 * What does this earn?
 *
 * `product.badge`. The most ordinary thing a loyalty scheme wants on a product
 * page and the one the platform cannot render, because the platform does not
 * know Fieldstone gives a point per rupee — or that paving earns double.
 *
 * Only for SKUs the platform asked about; only a sentence, never a price.
 */
app.post("/product/badge", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { skus, shopperId } = await c.req.json().catch(() => ({})) as {
    skus?: string[]; shopperId?: string | null;
  };
  if (!Array.isArray(skus) || skus.length === 0) return c.json({ badges: [] });

  const tier = shopperId ? await tierFor(token, caller.tenantId, shopperId) : null;
  const badges = skus.slice(0, 50).map((sku) => {
    const multiplier = BONUS_CATEGORIES.some((prefix) => sku.startsWith(prefix)) ? 2 : 1;
    return {
      sku,
      label: multiplier > 1 ? `Earns double points` : tier ? `${tier.name} member price` : `Earns points`,
      tone: multiplier > 1 ? "warning" : "info",
    };
  });
  return c.json({ badges });
});

/**
 * Member pricing.
 *
 * `cart.price`. Fieldstone's trade customers pay a contract rate, and the
 * platform has no column for "what this buyer's agreement says". Bounded on
 * both sides here as well as on the platform's: a discount, never an increase.
 */
app.post("/cart/price", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { lines, shopperId } = await c.req.json().catch(() => ({})) as {
    lines?: Array<{ sku?: string; unitPriceMinor?: number }>; shopperId?: string | null;
  };
  if (!Array.isArray(lines) || !shopperId) return c.json({ lines: [] });

  const tier = await tierFor(token, caller.tenantId, shopperId);
  if (!tier || tier.discountPercent <= 0) return c.json({ lines: [] });

  const priced = lines.flatMap((l) => {
    const was = Number(l.unitPriceMinor);
    if (!l.sku || !Number.isFinite(was) || was <= 0) return [];
    // Rounded DOWN, so rounding never works against the member.
    const now = Math.floor(was * (1 - tier.discountPercent / 100));
    if (now >= was) return [];
    return [{ sku: l.sku, unitPriceMinor: now, reason: `${tier.name} member price` }];
  });
  return c.json({ lines: priced });
});

/**
 * Delivery, by Fieldstone's own vans.
 *
 * `checkout.fulfilment`. Members get the Saturday slot free; everybody else
 * can buy it. The platform ships nothing and has no idea any of this exists.
 */
app.post("/checkout/fulfilment", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { shopperId, subtotalMinor } = await c.req.json().catch(() => ({})) as {
    shopperId?: string | null; subtotalMinor?: number;
  };
  const tier = shopperId ? await tierFor(token, caller.tenantId, shopperId) : null;
  const subtotal = Number(subtotalMinor) || 0;

  const options = [
    { id: "std", label: "Standard delivery", detail: "3-5 working days", surchargeMinor: 0 },
    {
      id: "sat-am",
      label: tier ? `Saturday morning (free for ${tier.name} members)` : "Saturday morning",
      detail: "9am-1pm, our own vans",
      // Never more than the basket: the platform refuses that, and a service
      // that relies on being refused is wrong the day the refusal moves.
      surchargeMinor: tier ? 0 : Math.min(25_00, subtotal),
    },
  ];
  return c.json({ options });
});

/**
 * Fieldstone's merchandising.
 *
 * `search.rerank`. Bonus-earning stock first — a retailer's opinion about its
 * own shelves. Reorders only: every SKU the platform sent comes back, because
 * a merchandising rule that hides stock is indistinguishable from an outage.
 */
app.post("/search/rerank", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { skus } = await c.req.json().catch(() => ({})) as { skus?: string[] };
  if (!Array.isArray(skus)) return c.json({ skus: [] });

  const bonus = skus.filter((s) => BONUS_CATEGORIES.some((p) => s.startsWith(p)));
  const rest = skus.filter((s) => !bonus.includes(s));
  return c.json({ skus: [...bonus, ...rest] });
});

/**
 * What Fieldstone's back office needs on the order.
 *
 * `order.enrich`. The points this order earned and the member's tier, attached
 * to the order itself so a returns desk can see them without asking us.
 *
 * Read-only as far as the platform is concerned: it stores these and branches
 * on none of them.
 */
app.post("/order/enrich", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { shopperId, totalMinor } = await c.req.json().catch(() => ({})) as {
    shopperId?: string | null; totalMinor?: number;
  };
  if (!shopperId) return c.json({ attributes: {} });

  const tier = await tierFor(token, caller.tenantId, shopperId);
  const earning = Math.floor((Number(totalMinor) || 0) / 100 * POINTS_PER_MAJOR_UNIT);
  return c.json({
    attributes: {
      loyaltyScheme: "Fieldstone Rewards",
      memberTier: tier?.name ?? "Guest",
      pointsEarned: String(earning),
      balanceAfter: String(await balance(token, caller.tenantId, shopperId) + earning),
    },
  });
});

/*
  ── What a shopper SEES ─────────────────────────────────────────────────────

  The hooks above decide what somebody is charged. These decide what they are
  told about it, which until now we had no way to do at all: the platform could
  take our discount and had nowhere to render the sentence explaining it.

  We do not ship code into their pages and would not want to — it would put our
  bugs inside somebody else's checkout. We answer with a short description and
  the platform draws it in the shop's own theme. The vocabulary is small on
  purpose; everything we can say in it is safe to say.
*/

/** Under the price on a product page. */
app.post("/ui/product-panel", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { sku, shopperId } = await c.req.json().catch(() => ({})) as { sku?: string; shopperId?: string | null };
  if (!sku) return c.json({ elements: [] });

  const bonus = BONUS_CATEGORIES.some((p) => sku.startsWith(p));
  const tier = shopperId ? await tierFor(token, caller.tenantId, shopperId) : null;

  const elements: Array<Record<string, unknown>> = [
    { type: "badge", label: bonus ? "Earns double points" : "Earns points", tone: bonus ? "warning" : "info" },
  ];
  if (tier) {
    elements.push({
      type: "text",
      text: tier.discountPercent > 0
        ? `${tier.name} members pay ${tier.discountPercent}% less on this.`
        : `You are a ${tier.name}. Keep buying to reach Gold.`,
    });
  }
  return c.json({ elements });
});

/** Beneath the basket summary. */
app.post("/ui/cart-summary", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { shopperId } = await c.req.json().catch(() => ({})) as { shopperId?: string | null };
  if (!shopperId) return c.json({ elements: [] });

  const points = await balance(token, caller.tenantId, shopperId);
  const toGold = Math.max(0, 1_000 - points);
  return c.json({
    elements: [
      toGold > 0
        ? { type: "text", text: `${points} points. ${toGold} more to reach Gold.`, tone: "info" }
        : { type: "text", text: `${points} points — enough to take money off at checkout.`, tone: "success" },
    ],
  });
});

/**
 * The shopper's own account page.
 *
 * The largest slot, and the only one where a shopper came deliberately to look
 * at their standing — so this is where the ledger gets explained rather than
 * summarised. "Why do I have 240 points" is the whole of loyalty support.
 */
app.post("/ui/account-panel", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);

  const { shopperId } = await c.req.json().catch(() => ({})) as { shopperId?: string | null };
  if (!shopperId) return c.json({ elements: [] });

  const points = await balance(token, caller.tenantId, shopperId);
  const tier = await tierFor(token, caller.tenantId, shopperId);
  const recent = (await history(token, caller.tenantId, shopperId)).slice(0, 5);

  const elements: Array<Record<string, unknown>> = [
    { type: "stat", label: "Points", value: points.toLocaleString("en-IN"), caption: tier?.name ?? "Not a member yet" },
  ];
  if (recent.length) {
    elements.push({
      type: "list",
      items: recent.map((e) => `${e.points > 0 ? "+" : ""}${e.points} — ${e.reason}`),
    });
  }
  if (tier && tier.discountPercent > 0) {
    elements.push({ type: "notice", text: `${tier.name} members get ${tier.discountPercent}% off and free Saturday delivery.`, tone: "info" });
  }
  return c.json({ elements });
});

/** Fieldstone's own staff, looking a shopper up. Not called by the platform. */
app.get("/points", async (c) => {
  const caller = await verifyPlatformCall(c.req.header("authorization"));
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? null;
  if (!caller) return c.json({ error: "unverified" }, 401);
  const shopperId = c.req.query("shopperId");
  if (!shopperId) return c.json({ error: "shopperId required" }, 400);
  return c.json({
    shopperId,
    balance: await balance(token, caller.tenantId, shopperId),
    history: (await history(token, caller.tenantId, shopperId)).slice(0, 20),
  });
});

const PORT = Number(process.env.PORT ?? 4500);
if (process.env.NODE_ENV !== "test") {
  serve({ fetch: app.fetch, port: PORT }, () =>
    console.log(`fieldstone-rewards listening on ${PORT} — Fieldstone's own service, not the platform's`),
  );
}

export default app;
