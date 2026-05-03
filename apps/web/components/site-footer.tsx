import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/70">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground sm:flex-row">
        <span>
          part of{" "}
          <Link
            href="https://nerv-analytic.ai"
            className="hover:text-primary transition-colors"
            rel="noopener noreferrer"
          >
            nerv-analytic.ai
          </Link>
        </span>
        <span>
          built by{" "}
          <Link
            href="https://nerv-analytic.ai"
            className="hover:text-primary transition-colors"
            rel="noopener noreferrer"
          >
            Connor Finnerty
          </Link>
        </span>
      </div>
    </footer>
  );
}
