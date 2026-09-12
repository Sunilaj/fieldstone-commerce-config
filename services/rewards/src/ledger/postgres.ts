/**
 * Fieldstone's real ledger.
 *
 * Their database, on their connection string, with their schema. The platform
 * does not have this URL and has no model for this table — which is the whole
 * claim of the extensibility story, stated as an operational fact rather than
 * as a promise.
 *
 * Raw `pg` rather than the platform's Prisma toolchain, deliberately: a tenant
 * building on the public APIs does not inherit our stack, and a service that
 * needed our ORM to participate would not be independent of us.
 */
import pg from "pg";
import type { Entry, Ledger } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rewards_entry (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    tenant_id   TEXT NOT NULL,
    shopper_id  TEXT NOT NULL,
    points      INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    -- Single-use, decided by the STORE.
    --
    -- An offer was double-spent end to end once, through a read-then-write
    -- check. Fixing that check left it racy: two concurrent redemptions both
    -- read "not recorded" and both write. A unique index is the only version of
    -- this that is true under concurrency.
    ref         TEXT NOT NULL UNIQUE
  );
  -- Balances are read on every product page and every checkout.
  CREATE INDEX IF NOT EXISTS rewards_entry_holder ON rewards_entry (tenant_id, shopper_id);
`;

/** Postgres's unique_violation. A duplicate is an answer, not a failure. */
const UNIQUE_VIOLATION = "23505";

export function postgresLedger(connectionString: string): Ledger {
  const pool = new pg.Pool({ connectionString, max: 4 });
  let prepared: Promise<void> | null = null;
  const ready = () => (prepared ??= pool.query(SCHEMA).then(() => undefined));

  const toEntry = (r: Record<string, unknown>): Entry => ({
    at: (r.at as Date).toISOString(),
    tenantId: r.tenant_id as string,
    shopperId: r.shopper_id as string,
    points: Number(r.points),
    reason: r.reason as string,
    ref: r.ref as string,
  });

  return {
    async balance(tenantId, shopperId) {
      await ready();
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(points), 0) AS total FROM rewards_entry WHERE tenant_id = $1 AND shopper_id = $2`,
        [tenantId, shopperId],
      );
      // SUM comes back as a string from pg for bigint-shaped results.
      return Number(rows[0]?.total ?? 0);
    },

    async record(entry) {
      await ready();
      try {
        const { rows } = await pool.query(
          `INSERT INTO rewards_entry (tenant_id, shopper_id, points, reason, ref)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [entry.tenantId, entry.shopperId, entry.points, entry.reason, entry.ref],
        );
        return { written: true, entry: toEntry(rows[0]) };
      } catch (e) {
        if ((e as { code?: string }).code === UNIQUE_VIOLATION) return { written: false, entry: null };
        throw e;
      }
    },

    async history(tenantId, shopperId) {
      await ready();
      const { rows } = await pool.query(
        `SELECT * FROM rewards_entry WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id DESC LIMIT 200`,
        [tenantId, shopperId],
      );
      return rows.map(toEntry);
    },

    async spent(_shopperId, ref) {
      await ready();
      const { rows } = await pool.query(`SELECT 1 FROM rewards_entry WHERE ref = $1 LIMIT 1`, [ref]);
      return rows.length > 0;
    },

    async check() {
      await ready();
      await pool.query("SELECT 1");
    },
  };
}
