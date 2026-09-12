/**
 * Verifying that a request really came from Flipkart Commerce Cloud.
 *
 * This service gives away money on the strength of these calls, so an unsigned
 * one is refused. The platform signs with its identity plane and publishes the
 * public keys; this checks against them, with the audience the platform stamps
 * for calls OUT to somebody else's software.
 *
 * `fcc-extension`, specifically, and not `fcc-services`. If this accepted a
 * service-plane token, a credential leaked from anywhere inside the platform
 * could be replayed here to mint discounts — and a token meant for one purpose
 * being accepted for another is the confusion audiences exist to prevent.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const PLATFORM = process.env.FCC_PLATFORM_URL ?? "http://localhost:3000";
const AUDIENCE = "fcc-extension";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keys() {
  jwks ??= createRemoteJWKSet(new URL(`${PLATFORM}/api/identity/jwks`));
  return jwks;
}

export interface Caller {
  tenantId: string;
  scopes: string[];
}

/**
 * The tenant the platform says this call is for, or null.
 *
 * Null rather than a throw: every caller here answers a shopper who is waiting,
 * and the right response to an unverifiable request is a plain refusal, not a
 * stack trace in somebody's checkout.
 */
export async function verifyPlatformCall(authorization: string | undefined): Promise<Caller | null> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys(), { audience: AUDIENCE });
    const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : null;
    if (!tenantId) return null;
    return {
      tenantId,
      scopes: Array.isArray(payload.scp) ? (payload.scp as string[]) : [],
    };
  } catch {
    return null;
  }
}
