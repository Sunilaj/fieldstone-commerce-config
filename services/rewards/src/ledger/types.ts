/**
 * Where Fieldstone's points live.
 *
 * ## Why this is a seam and not just a table
 *
 * Fieldstone Rewards is a tenant's OWN service, built on the platform's public
 * APIs. Its data is Fieldstone's: the platform has no schema for it, no
 * credentials to it, and no query that reaches it. That is not a convention —
 * it is the boundary that makes "custom code cannot affect the platform or
 * another tenant" true rather than promised.
 *
 * Two implementations satisfy this interface. The Postgres one is what a real
 * scheme runs. The file one is a deterministic simulator for tests, and it
 * exists so the test suite does not need a database server — the same shape as
 * the platform's own payment-gateway seam.
 *
 * ## The rule both obey
 *
 * A ledger is APPEND-ONLY. Points are earned and spent as entries and a balance
 * is their sum. A mutable counter makes "why do I have 240 points" unanswerable,
 * which for a loyalty scheme is the whole of customer support.
 *
 * And `record` is the ONLY place single-use is decided. `ref` is unique: a
 * second write of the same reference must fail in the STORE, not in an `if`
 * above it. The double-spend that was found by running the whole flow got past
 * a read-then-write check, and a read-then-write check is still racy after the
 * bug it missed is fixed — two concurrent redemptions of one offer both read
 * "not yet recorded" and both write.
 */
export interface Entry {
  at: string;
  tenantId: string;
  shopperId: string;
  /** Positive to earn, negative to spend. */
  points: number;
  reason: string;
  /** The order or offer this relates to, for tracing a balance back. */
  ref: string;
}

export interface Ledger {
  /** The sum of a shopper's entries, scoped to a tenant. */
  balance(tenantId: string, shopperId: string): Promise<number>;
  /**
   * Appends one entry, or reports that its `ref` is already spent.
   *
   * Never throws on a duplicate: a duplicate is an ANSWER — the webhook fabric
   * retries, and a scheme that treated a retry as an error would fail deliveries
   * it had already honoured.
   */
  record(entry: Omit<Entry, "at">): Promise<{ written: boolean; entry: Entry | null }>;
  history(tenantId: string, shopperId: string): Promise<Entry[]>;
  /**
   * Has this reference already been written?
   *
   * Decides the WORDS a shopper reads, never the outcome — `record` decides
   * that, and only `record` is safe under concurrency. Without this, a re-used
   * offer was refused by the affordability check first and the shopper was told
   * "those points are no longer available" about points they still had. True in
   * a sense, and useless: they had not run out, they had already spent this one.
   */
  spent(shopperId: string, ref: string): Promise<boolean>;
  /** Readiness, so a misconfigured deployment is loud at startup and not at checkout. */
  check(): Promise<void>;
}
