import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  signSession,
  toPublicUser,
  verifyCredentials,
} from "@/lib/auth";

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as { username?: string; password?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (!body.username || !body.password) {
    return NextResponse.json(
      { error: "Username and password are required" },
      { status: 400 },
    );
  }

  const user = verifyCredentials(body.username, body.password);
  if (!user) {
    return NextResponse.json(
      { error: "Wrong username or password" },
      { status: 401 },
    );
  }

  const res = NextResponse.json({ user: toPublicUser(user) });
  res.cookies.set(SESSION_COOKIE, signSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 8,
  });
  return res;
}
