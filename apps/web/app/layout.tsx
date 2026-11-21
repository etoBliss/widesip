import "./globals.css";
import "./design-system.css";
import "./responsive-system.css";
import "./navigation-usage.css";
import "./domains-compact.css";
import "./polish-system.css";
import "./full-redesign.css";
import "./dropdown-system.css";
import "./onboarding-flow.css";
import "./auth-redesign.css";
import "./calendar-modal.css";
import "./landing-refresh.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthPageGate } from "@/components/auth-page-gate";

export const metadata: Metadata = {
  title: "Widesip — Your email. Your domains. One place.",
  description: "Bring domains, email addresses, conversations, contacts and teammates into one clear Widesip workspace.",
  icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body><AuthPageGate>{children}</AuthPageGate></body></html>;
}
