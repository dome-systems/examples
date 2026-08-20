import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  verifySession,
  type UserProfile,
} from "@/lib/auth";

/** Read the signed-in user from the session cookie (server only). */
export async function getCurrentUser(): Promise<UserProfile | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}
