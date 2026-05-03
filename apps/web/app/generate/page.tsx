import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { GeneratorPanel } from "./generator-panel";

export const metadata = {
  title: "Generate — Loom",
};

export default function Generate() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">
        <section className="px-6 py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              dual-language subtitle generator
            </p>
            <h1 className="mt-4 font-serif text-4xl font-light tracking-tight sm:text-5xl">
              Generate
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Drop a video, pick the subtitle track in your language and the
              one in the language of the media, and Loom emits a stitched{" "}
              <code className="font-mono text-foreground/80">.ass</code> file +
              a PGS{" "}
              <code className="font-mono text-foreground/80">.sup</code>{" "}
              bitmap track.  Everything happens in your browser — the video
              never leaves the page.
            </p>
          </div>
        </section>

        <section className="flex-1 border-t border-border/60 px-6 py-10">
          <div className="mx-auto max-w-3xl">
            <GeneratorPanel />
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
