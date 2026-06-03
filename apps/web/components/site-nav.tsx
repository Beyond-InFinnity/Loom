// Top-of-page chrome.  Brand link to the main portfolio site on the left,
// nav links on the right.  Match the marketing site's visual feel:
// minimal, dark, transparent backdrop, gold accent on hover.

import Link from "next/link";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link
          href="https://nerv-analytic.ai"
          className="text-sm font-light tracking-widest text-muted-foreground hover:text-primary transition-colors"
          rel="noopener noreferrer"
        >
          ← nerv-analytic
        </Link>
        <Link
          href="/"
          className="font-serif text-2xl font-medium tracking-wide text-primary"
        >
          Loom
        </Link>
        <nav className="flex items-center gap-5 text-sm text-muted-foreground">
          <Link href="/extension" className="hover:text-primary transition-colors">
            Extension
          </Link>
          <Link href="/generate" className="hover:text-primary transition-colors">
            Generate
          </Link>
          <Link
            href="https://github.com/Beyond-InFinnity/Loom"
            className="hover:text-primary transition-colors"
            rel="noopener noreferrer"
          >
            GitHub
          </Link>
        </nav>
      </div>
    </header>
  );
}
