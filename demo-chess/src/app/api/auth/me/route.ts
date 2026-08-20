import { NextResponse } from "next/server";
import { toPublicUser } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({ user: toPublicUser(user) });
}
