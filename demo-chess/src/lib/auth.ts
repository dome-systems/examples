import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Mock auth server for the demo.
 *
 * Two accounts with genuinely different coaching profiles so delegated
 * identity is observable: the same app, the same board, different answers,
 * different engine depth, different per-user Quota.
 *
 * Passwords are intentionally trivial (alex:alex, sam:sam) — this stands in
 * for an IdP. When Dome act-as is wired, this session becomes the verified
 * end-user identity sent on every governed call.
 */

export type UserId = "alex" | "sam";

export type UserProfile = {
  id: UserId;
  password: string;
  name: string;
  email: string;
  /** Displayed skill level */
  level: string;
  rating: number;
  /** Fallback coach voice if Dome agent metadata is unavailable */
  coachStyle: string;
  /** Engine depth this user is allowed to request */
  maxDepth: number;
  /** Tools this user's coach may call */
  tools: string[];
  groups: string[];
  highlights: string[];
};

export const USERS: Record<UserId, UserProfile> = {
  alex: {
    id: "alex",
    password: "alex",
    name: "Alex Rivera",
    email: "alex@example.com",
    level: "Club player",
    rating: 1780,
    coachStyle:
      "Terse and tactical. Names openings, gives concrete variations, assumes you know the notation.",
    maxDepth: 16,
    tools: ["chess_engine"],
    groups: ["players", "club"],
    highlights: [
      "Deeper engine search (depth 16)",
      "Variations in algebraic notation",
      "Club coaching profile",
      "Higher Dome daily spend cap",
    ],
  },
  sam: {
    id: "sam",
    password: "sam",
    name: "Sam Doyle",
    email: "sam@example.com",
    level: "Beginner",
    rating: 900,
    coachStyle:
      "Plain language. Explains why a move is bad before what to play, avoids jargon and long variations.",
    maxDepth: 10,
    tools: ["chess_engine"],
    groups: ["players"],
    highlights: [
      "Lighter engine search (depth 10)",
      "Plain-language explanations",
      "Opening book not available",
      "Lower Dome daily spend cap",
    ],
  },
};

export function listUsers(): UserProfile[] {
  return [USERS.alex, USERS.sam];
}

export function verifyCredentials(
  username: string,
  password: string,
): UserProfile | null {
  const key = username.trim().toLowerCase() as UserId;
  const user = USERS[key];
  if (!user) return null;

  const a = Buffer.from(password);
  const b = Buffer.from(user.password);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return user;
}

/** Public shape sent to the browser — never includes the password. */
export type PublicUser = Omit<UserProfile, "password">;

export function toPublicUser(user: UserProfile): PublicUser {
  const rest: Partial<UserProfile> = { ...user };
  delete rest.password;
  return rest as PublicUser;
}

const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET || "demo-chess-dev-secret";

export const SESSION_COOKIE = "demo_chess_session";

export function signSession(userId: UserId): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: Date.now() }),
  ).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined): UserProfile | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const { sub } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sub?: UserId };
    if (!sub) return null;
    return USERS[sub] ?? null;
  } catch {
    return null;
  }
}
