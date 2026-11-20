import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-instrument-sans",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-instrument-serif",
});

export const metadata: Metadata = {
  title: "FirstMerge — Open-Source Issue Directory & Maintainer Health Index",
  description:
    "Editorial directory of verified unassigned, zero-open-PR GitHub issues matched to your real stack.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${instrumentSerif.variable}`}>
      <body className="min-h-screen bg-[#F7F4EC] text-[#000000] antialiased selection:bg-[#000000] selection:text-[#F7F4EC]">
        {children}
      </body>
    </html>
  );
}

