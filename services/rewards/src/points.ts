/**
 * Fieldstone's store, chosen once.
 *
 * `REWARDS_DATABASE_URL` selects the real ledger; `REWARDS_LEDGER` selects the
 * deterministic file one used by the tests. Setting NEITHER is refused rather
 * than defaulted — the platform's payment seam takes the same line, and for the
 * same reason: a service that quietly invents a store when its database is
 * missing will be discovered holding somebody's balances in a temp file.
 */
import { fileLedger } from "./ledger/file.js";
import { platformLedger } from "./ledger/platform.js";
import { postgresLedger } from "./ledger/postgres.js";
import type { Ledger } from "./ledger/types.js";

export type { Entry } from "./ledger/types.js";

let chosen: Ledger | null = null;

/**
 * The store, for a request that carries the platform's token.
 *
 * Three choices, in the order a team would meet them:
 *
 *   `REWARDS_STORAGE_URL`   the platform's own storage, opened with the token
 *                           it already sent on this call. Nothing to provision.
 *   `REWARDS_DATABASE_URL`  Fieldstone's own Postgres, on Fieldstone's own role.
 *   `REWARDS_LEDGER`        a file. Tests, and nothing else.
 *
 * Platform storage is per-REQUEST and the other two are per-process, which is
 * the whole reason this takes a token: the credential that opens it is the
 * short-lived one the platform hands over on each hook call, so Fieldstone
 * never holds a long-lived platform credential at all.
 *
 * Nothing is defaulted. A loyalty service that quietly invents a store when its
 * database is missing gets discovered holding somebody's balances in /tmp.
 */
export function ledgerFor(token: string | null): Ledger {
  const platform = process.env.REWARDS_STORAGE_URL;
  if (platform) {
    if (!token) throw new Error("Platform storage needs the token the platform sent with this call.");
    return platformLedger(platform, token);
  }
  return ledger();
}

export function ledger(): Ledger {
  if (chosen) return chosen;
  const url = process.env.REWARDS_DATABASE_URL;
  const file = process.env.REWARDS_LEDGER;
  if (url) return (chosen = postgresLedger(url));
  if (file) return (chosen = fileLedger(file));
  throw new Error(
    "Fieldstone Rewards has no ledger configured. Set REWARDS_STORAGE_URL to use the platform's " +
    "storage, REWARDS_DATABASE_URL for a database of your own, or REWARDS_LEDGER for a file in " +
    "tests. There is deliberately no default: balances are money.",
  );
}

/** Test seam only — the process picks its store once, and a suite runs many. */
export function resetLedgerForTests() { chosen = null; }

/*
  Every one of these takes the request's token now.

  It reads as noise on the file and Postgres stores, which ignore it. It is the
  entire mechanism on the platform store, and making it optional would mean a
  handler that forgot it silently fell back to a different tenant's process-wide
  ledger — the one mistake in this file that would be invisible in testing,
  because tests run one tenant.
*/
export const balance = (token: string | null, tenantId: string, shopperId: string) =>
  ledgerFor(token).balance(tenantId, shopperId);
export const history = (token: string | null, tenantId: string, shopperId: string) =>
  ledgerFor(token).history(tenantId, shopperId);
export const record = (token: string | null, entry: Parameters<Ledger["record"]>[0]) =>
  ledgerFor(token).record(entry);
export const spent = (token: string | null, shopperId: string, ref: string) =>
  ledgerFor(token).spent(shopperId, ref);
