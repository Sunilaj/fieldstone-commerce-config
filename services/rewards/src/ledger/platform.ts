/**
 * Fieldstone's ledger, held by the platform.
 *
 * ## The point of this implementation existing
 *
 * The other two are Fieldstone's own: a Postgres database on Fieldstone's own
 * role, and a file for tests. Both work, and the Postgres one is what a team
 * with a DBA would choose.
 *
 * But "build on our APIs, and provision your own database first" is a project
 * standing in front of a feature. The interesting part of a loyalty scheme is
 * its rules; requiring Postgres before the first rule is written is friction
 * the platform can simply remove. So the platform sells storage, and this is
 * Fieldstone taking it.
 *
 * Nothing above this file changes. That is the whole argument for the seam: the
 * same `Ledger` interface, the same tests, a different place the bytes live.
 *
 * ## The credential
 *
 * The token the platform ALREADY sent on this hook call. It is short-lived, it
 * names this tenant and this extension, and it is the only thing that opens
 * this storage — so a ledger is built per request rather than once at startup,
 * and Fieldstone never holds a long-lived platform credential at all.
 *
 * ## What this cannot do
 *
 * Reach another tenant, or another extension's namespace. Not by convention:
 * the service takes both from the token and there is no request shape that
 * names a different one.
 */
import type { Entry, Ledger } from "./types.js";

const COLLECTION = "ledger";

interface Stored { tenantId: string; shopperId: string; points: number; reason: string; ref: string; at: string }

/**
 * A key that sorts by shopper, so a balance is one page rather than a scan.
 *
 * `ref` is already unique per entry — it is what makes a burn single-use — so
 * it goes on the end rather than being replaced by anything cleverer.
 */
const keyFor = (shopperId: string, ref: string) => `${shopperId}:${ref}`.replace(/[^A-Za-z0-9._:-]/g, "-");

export function platformLedger(baseUrl: string, token: string): Ledger {
  const root = `${baseUrl.replace(/\/+$/, "")}/records/${COLLECTION}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  /** Every entry this shopper has, paged. */
  async function page(shopperId: string): Promise<Stored[]> {
    const out: Stored[] = [];
    let after: string | null = `${shopperId}:`;
    // The cursor is exclusive and keys sort lexically, so starting at
    // `<shopper>:` lands immediately before this shopper's first entry.
    for (let guard = 0; guard < 50; guard++) {
      const url = `${root}?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`extension-storage answered ${res.status} listing the ledger`);
      const body = await res.json() as { data: Array<{ key: string; value: Stored }>; meta: { next: string | null } };
      for (const row of body.data) {
        // Lexical order means the page runs PAST this shopper into the next.
        if (!row.key.startsWith(`${shopperId}:`)) return out;
        if (row.value.shopperId === shopperId) out.push(row.value);
      }
      after = body.meta.next;
      if (!after) break;
    }
    return out;
  }

  return {
    async balance(tenantId, shopperId) {
      // `tenantId` is not sent: the token decides it, and a service that let a
      // caller name the tenant would be a service with a tenant-crossing bug
      // waiting for somebody to try it.
      void tenantId;
      return (await page(shopperId)).reduce((sum, e) => sum + e.points, 0);
    },

    async record(entry) {
      const full: Entry = { ...entry, at: new Date().toISOString() };
      const res = await fetch(`${root}/${encodeURIComponent(keyFor(entry.shopperId, entry.ref))}`, {
        method: "PUT",
        headers,
        /*
          `ifAbsent`, which is what makes a burn single-use.

          Not a read-then-write above this call: two concurrent redemptions both
          read "not spent" and both write, and this platform has already shipped
          exactly that bug end to end. The unique index refuses the second, and a
          409 here is the answer — not an error.
        */
        body: JSON.stringify({ value: full, ifAbsent: true }),
      });
      if (res.status === 409) return { written: false, entry: null };
      if (!res.ok) throw new Error(`extension-storage answered ${res.status} writing a ledger entry`);
      return { written: true, entry: full };
    },

    async history(tenantId, shopperId) {
      void tenantId;
      return (await page(shopperId)).sort((a, b) => b.at.localeCompare(a.at));
    },

    async spent(shopperId, ref) {
      /*
        An exact read, not a scan.

        The first version of this listed the collection and looked for a
        matching `ref` — correct for a ledger of two hundred entries and wrong
        for a real one, where the answer would have been "no" simply because the
        entry was on page nine. The key already encodes the shopper, so the
        question has an address.
      */
      const res = await fetch(`${root}/${encodeURIComponent(keyFor(shopperId, ref))}`, { headers });
      return res.ok;
    },

    async check() {
      const res = await fetch(`${root.replace(`/records/${COLLECTION}`, "")}/usage`, { headers });
      if (!res.ok) throw new Error(`extension-storage answered ${res.status}`);
    },
  };
}
