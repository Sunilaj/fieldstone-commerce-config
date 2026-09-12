// @vitest-environment node
/**
 * Three stores, one contract.
 *
 * ## Why this file exists
 *
 * `ledger/types.ts` claims the store is interchangeable — a file for tests,
 * Fieldstone's own Postgres, or the platform's storage for a team that does not
 * want to run a database. A claim like that is worth nothing until two
 * implementations that share no code pass the same tests.
 *
 * The one that matters is `record`. It is easy to write a store that appends,
 * and an appending store means a REDEMPTION IS NOT SINGLE-USE — which is not a
 * hypothetical here: an offer was double-spent end to end on this very service,
 * and the fix (a read, then a write) was still racy under two concurrent
 * requests. Only the store can settle that, so only the store is allowed to.
 *
 * ## The third implementation
 *
 * `platformLedger` talks HTTP to the platform's `extension-storage` service and
 * is therefore not exercised here: standing the platform up inside this
 * package's unit tests would mean this service — a THIRD PARTY, deliberately —
 * importing the platform's source. It is proved end to end instead, against the
 * running service, which is the only tier that proves anything about HTTP.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { fileLedger } from "../src/ledger/file.js";
import { postgresLedger } from "../src/ledger/postgres.js";
import type { Ledger } from "../src/ledger/types.js";

/*
  Fieldstone's own database, on Fieldstone's own role.

  Not the platform's `fcc` role and not a platform database: the whole claim of
  this service is that its data is ITS data. `fcc_app`, the non-superuser
  platform role, is refused CONNECT on this database — proved in the E2E, not
  here, because a grant is a deployment fact rather than a code one.
*/
const PG_URL = process.env.REWARDS_TEST_DATABASE_URL
  ?? "postgresql://fieldstone:fieldstone@localhost:5432/fieldstone_rewards";

let dir: string;
const pool = new pg.Pool({ connectionString: PG_URL });

const IMPLEMENTATIONS: Array<[string, () => Ledger]> = [
  ["file", () => fileLedger(join(dir, "ledger.json"))],
  ["postgres", () => postgresLedger(PG_URL)],
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ledger-contract-"));
  // The Postgres store is shared across runs, so it is emptied rather than
  // recreated: a per-test schema would test a table this service never uses.
  await pool.query("DROP TABLE IF EXISTS rewards_entry").catch(() => {});
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await pool.end().catch(() => {});
});

describe.each(IMPLEMENTATIONS)("%s satisfies the ledger contract", (_name, make) => {
  const T = "t-fieldstone";

  it("a balance is the sum of the entries, and starts at nothing", async () => {
    const l = make();
    expect(await l.balance(T, "s1")).toBe(0);
    await l.record({ tenantId: T, shopperId: "s1", points: 240, reason: "Order paid", ref: "order:o1" });
    await l.record({ tenantId: T, shopperId: "s1", points: -100, reason: "Redeemed", ref: "spend:x" });
    expect(await l.balance(T, "s1")).toBe(140);
  });

  it("REFUSES a second write of the same reference, and says so rather than throwing", async () => {
    // The whole reason single-use is the store's job. A retrying webhook and a
    // double-clicked Pay are the two ways this is reached in anger, and both
    // are ordinary events rather than errors.
    const l = make();
    expect(await l.record({ tenantId: T, shopperId: "s1", points: 10, reason: "x", ref: "r1" }))
      .toMatchObject({ written: true });
    expect(await l.record({ tenantId: T, shopperId: "s1", points: 10, reason: "x", ref: "r1" }))
      .toMatchObject({ written: false, entry: null });
    expect(await l.balance(T, "s1"), "the duplicate was counted").toBe(10);
  });

  it("refuses the duplicate even when both writes are in flight at once", async () => {
    /*
      The case a read-then-write check cannot see, and the reason `record`
      returns a verdict instead of the caller asking first. Run against the real
      store, because this is precisely what a fake would get wrong.
    */
    const l = make();
    const both = await Promise.all([
      l.record({ tenantId: T, shopperId: "s1", points: 50, reason: "x", ref: "race" }),
      l.record({ tenantId: T, shopperId: "s1", points: 50, reason: "x", ref: "race" }),
    ]);
    expect(both.filter((r) => r.written).length, "both writes were accepted").toBe(1);
    expect(await l.balance(T, "s1")).toBe(50);
  });

  it("keeps one shopper's points away from another's", async () => {
    const l = make();
    await l.record({ tenantId: T, shopperId: "s1", points: 10, reason: "x", ref: "a" });
    await l.record({ tenantId: T, shopperId: "s2", points: 99, reason: "x", ref: "b" });
    expect(await l.balance(T, "s1")).toBe(10);
    expect(await l.balance(T, "s2")).toBe(99);
  });

  it("keeps one tenant's points away from another's", async () => {
    // Fieldstone runs one shop. Scoping anyway costs nothing, and the failure
    // it prevents is impossible to notice while there is only ever one tenant.
    const l = make();
    await l.record({ tenantId: T, shopperId: "s1", points: 10, reason: "x", ref: "a" });
    await l.record({ tenantId: "t-other", shopperId: "s1", points: 500, reason: "x", ref: "b" });
    expect(await l.balance(T, "s1")).toBe(10);
  });

  it("answers whether a reference has been spent, which is what the shopper is told", async () => {
    const l = make();
    expect(await l.spent("s1", "spend:1")).toBe(false);
    await l.record({ tenantId: T, shopperId: "s1", points: -5, reason: "x", ref: "spend:1" });
    expect(await l.spent("s1", "spend:1")).toBe(true);
  });

  it("reads back a history, newest first, so a balance can be explained", async () => {
    const l = make();
    await l.record({ tenantId: T, shopperId: "s1", points: 10, reason: "first", ref: "a" });
    await l.record({ tenantId: T, shopperId: "s1", points: 20, reason: "second", ref: "b" });
    const h = await l.history(T, "s1");
    expect(h.map((e) => e.reason)).toEqual(["second", "first"]);
  });

  it("is ready, or says it is not", async () => {
    await expect(make().check()).resolves.not.toThrow();
  });
});
