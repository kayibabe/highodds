import type { Metadata } from "next";
import { auth, isAuthDisabled, LOCAL_ACCESS_EMAIL } from "../auth";
import AppShell from "./app-shell";
import "./styles.css";

export const metadata: Metadata = {
  title: "HighOdds | Football research, with the evidence in view",
  description: "See the signal. Keep the evidence. Review football forecasts, captured prices, and outcomes in one research workspace.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const localAccess = isAuthDisabled();
  const session = localAccess ? { user: { email: LOCAL_ACCESS_EMAIL, role: "ADMIN" as const } } : await auth();
  return <html lang="en" suppressHydrationWarning><body><AppShell email={session?.user?.email ?? null} isAdmin={session?.user?.role === "ADMIN"} localAccess={localAccess}>{children}</AppShell></body></html>;
}
