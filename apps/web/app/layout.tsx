import type { Metadata } from "next";
import "./globals.css";

// Fonts ship via the @import in globals.css (Inter, JetBrains Mono,
// Cormorant Garamond — same set the marketing site uses).  No
// next/font/google here — keeping the font pipeline identical to
// nerv-analytic.ai means copy-pasting tokens between repos stays cheap.

export const metadata: Metadata = {
  title: "Loom — polyglot subtitle intelligence",
  description:
    "Browser-side dual-language subtitle generator with phonetic overlay tracks for Japanese, Mandarin, Cantonese, Korean, Thai, Cyrillic, Indic, Hebrew, Arabic, Persian and Urdu.",
  metadataBase: new URL("https://loom.nerv-analytic.ai"),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
