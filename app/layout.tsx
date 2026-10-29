import type { Metadata } from "next";
import { Azeret_Mono, Instrument_Serif, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument" });
const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted" });
const mono = Azeret_Mono({ subsets: ["latin"], variable: "--font-azeret" });

export const metadata: Metadata = {
  title: "Jev Workspace",
  description: "Give Jev a mission and some links. Watch it judge everything, live.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Browser extensions stamp attributes on <html> and <body> before React loads (ColorZilla adds
    // cz-shortcut-listen). suppressHydrationWarning ignores that on these two elements only.
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
