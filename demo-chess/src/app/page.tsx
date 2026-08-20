import { LoginScreen } from "@/components/LoginScreen";
import { ChessApp } from "@/components/ChessApp";
import { listUsers, toPublicUser } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";

export default async function Home() {
  const user = await getCurrentUser();

  if (!user) {
    return <LoginScreen accounts={listUsers().map(toPublicUser)} />;
  }

  return <ChessApp user={toPublicUser(user)} />;
}
