/**
 * The deterministic ledger. Fieldstone's test double, not its database.
 *
 * A file, so the suite needs no server. Chosen explicitly by setting
 * `REWARDS_LEDGER` — never fallen back to, because a loyalty service that
 * silently stores balances in /tmp when its database is unreachable is worse
 * than one that refuses to start.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry, Ledger } from "./types.js";

export function fileLedger(path: string): Ledger {
  const load = (): Entry[] => {
    try { return JSON.parse(readFileSync(path, "utf8")) as Entry[]; } catch { return []; }
  };
  const save = (entries: Entry[]) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entries, null, 2));
  };

  return {
    async balance(tenantId, shopperId) {
      return load()
        .filter((e) => e.tenantId === tenantId && e.shopperId === shopperId)
        .reduce((sum, e) => sum + e.points, 0);
    },
    async record(entry) {
      const entries = load();
      // The same uniqueness the Postgres ledger gets from an index. Written
      // here so the two stores cannot disagree about what a duplicate is.
      if (entries.some((e) => e.ref === entry.ref)) return { written: false, entry: null };
      const full: Entry = { ...entry, at: new Date().toISOString() };
      entries.push(full);
      save(entries);
      return { written: true, entry: full };
    },
    async history(tenantId, shopperId) {
      return load().filter((e) => e.tenantId === tenantId && e.shopperId === shopperId).reverse();
    },
    // `shopperId` is not needed here — a ref is unique across the ledger — but
    // it is in the signature because the platform-backed store keys by shopper
    // and would otherwise have to scan.
    async spent(_shopperId, ref) { return load().some((e) => e.ref === ref); },
    async check() { /* a file is always ready */ },
  };
}
