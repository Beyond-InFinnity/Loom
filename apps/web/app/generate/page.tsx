import Link from "next/link";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

// Placeholder for Step 4e-3: this is where the drop-zone → tracks →
// generate-ASS+SUP → download flow will land.  Pointing visitors at
// /ffmpeg-test in the meantime since the underlying pipeline already
// works there end-to-end.

export default function Generate() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 items-center justify-center px-6 py-24">
        <div className="max-w-xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
            in progress
          </p>
          <h1 className="mt-6 font-serif text-4xl font-light tracking-tight">
            Generator UI
          </h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            The polished drop-zone + track picker lands in the next slice.  The
            same pipeline already works end-to-end on the diagnostics page —
            drop a video, pick native + target, click <em>Generate ASS + SUP</em>.
          </p>
          <Link
            href="/ffmpeg-test"
            className="mt-8 inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20 hover:border-primary"
          >
            Use the diagnostics page →
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
