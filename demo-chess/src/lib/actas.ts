import { createHmac } from "node:crypto";
import type { PublicUser } from "@/lib/auth";

export type ActAsIdentity = {
  sub: string;
  email: string;
  groups: string[];
  roles?: string[];
  claims?: Record<string, string>;
};

export function identityFromUser(user: PublicUser): ActAsIdentity {
  return {
    sub: user.id,
    email: user.email,
    groups: [...user.groups],
  };
}

/** Sign an HMAC act-as envelope for X-Dome-Act-As (matches Dome gateway). */
export function signHMACActAs(
  secret: string,
  identity: ActAsIdentity,
  ts = Math.floor(Date.now() / 1000),
): string {
  if (!identity.sub && !identity.email) {
    throw new Error("act-as identity requires sub or email");
  }

  const payload: Record<string, unknown> = { _ts: ts };
  if (identity.sub) payload.sub = identity.sub;
  if (identity.email) payload.email = identity.email;
  if (identity.roles?.length) payload.roles = identity.roles;
  if (identity.groups?.length) payload.groups = identity.groups;
  if (identity.claims && Object.keys(identity.claims).length) {
    payload.claims = identity.claims;
  }

  const canonical = `${canonicalJson(payload)}|${ts}`;
  const digest = createHmac("sha256", secret).update(canonical).digest();
  payload._signature = digest.toString("base64url");

  return Buffer.from(canonicalJson(payload)).toString("base64");
}

export function actAsHeaderForUser(user: PublicUser): string | undefined {
  const secret = process.env.DOME_ACTAS_SECRET?.trim();
  if (!secret) return undefined;
  return signHMACActAs(secret, identityFromUser(user));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}
