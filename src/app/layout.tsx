import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, Old_Standard_TT, Pinyon_Script } from "next/font/google";
import "./globals.css";

/* Plate titles: a Didone, cut for display, with its optical-size axis. */
const bodoni = Bodoni_Moda({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-bodoni",
  display: "swap",
});

/* Book text and labels: a late-Victorian "modern" face, as the scientific press used. */
const oldStandard = Old_Standard_TT({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-oldstandard",
  display: "swap",
});

/* Dr. Vance's hand: copperplate. */
const pinyon = Pinyon_Script({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pinyon",
  display: "swap",
});

export const metadata: Metadata = {
  title: "The Hollow Hill",
  description:
    "A living formicarium, after the notebooks of Dr. Aurelie Vance, 1893. An ant colony that lives in real time, digs its own tunnels, keeps your clock, and remembers you.",
  openGraph: {
    title: "The Hollow Hill",
    description: "A living formicarium, after the notebooks of Dr. Aurelie Vance, 1893.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#14100c",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={`${bodoni.variable} ${oldStandard.variable} ${pinyon.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
