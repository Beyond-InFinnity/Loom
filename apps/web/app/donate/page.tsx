import Link from "next/link";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "Donate — Loom",
  description:
    "Support the development of Loom — dual-language subtitles with romanization for language learners.",
};

// Hosted at loom.nerv-analytic.ai/donate — the "☕ Donate" buttons (footer +
// landing page) point here. Note: /support is the technical support / FAQ page
// (the convention the extension stores expect); this page is donations only.
//
// Fill in the three handles below to take a method live. An empty string ("")
// hides that method's card, so the page is always safe to ship — it just shows
// whatever is configured (or a "coming soon" note if none are).
//   PayPal   → paypal.me/<PAYPAL_ME>
//   Venmo    → venmo.com/u/<VENMO_USER>
//   Cash App → cash.app/$<CASHAPP_TAG>
const PAYPAL_ME = "ConnorMFinnerty"; // paypal.me/ConnorMFinnerty
const VENMO_USER = "Connor-Finnerty-1"; // venmo.com/u/Connor-Finnerty-1
const CASHAPP_TAG = ""; // off for now — PayPal + Venmo cover 95%+ of cases

type Method = { name: string; handle: string; url: string; blurb: string };

const METHODS: Method[] = (
  [
    PAYPAL_ME && {
      name: "PayPal",
      handle: `paypal.me/${PAYPAL_ME}`,
      url: `https://paypal.me/${PAYPAL_ME}`,
      blurb: "One-click via PayPal.Me — any amount.",
    },
    VENMO_USER && {
      name: "Venmo",
      handle: `@${VENMO_USER}`,
      url: `https://venmo.com/u/${VENMO_USER}`,
      blurb: "Send a tip on Venmo.",
    },
    CASHAPP_TAG && {
      name: "Cash App",
      handle: `$${CASHAPP_TAG}`,
      url: `https://cash.app/$${CASHAPP_TAG}`,
      blurb: "Send a tip on Cash App.",
    },
  ] as (Method | "" | false)[]
).filter(Boolean) as Method[];

function MethodCard({ method }: { method: Method }) {
  return (
    <Link
      href={method.url}
      rel="noopener noreferrer"
      target="_blank"
      className="group flex w-full flex-col rounded-lg border border-border/60 bg-background/40 p-6 transition-colors hover:border-primary/60 hover:bg-primary/5 sm:w-72"
    >
      <h3 className="font-serif text-2xl font-medium text-foreground">
        {method.name}
      </h3>
      <p className="mt-1 font-mono text-xs text-accent">{method.handle}</p>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">
        {method.blurb}
      </p>
      <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary">
        Open {method.name} →
      </span>
    </Link>
  );
}

export default function Donate() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              donate
            </p>
            <h1 className="mt-4 font-serif text-4xl font-light tracking-tight text-foreground sm:text-5xl">
              ☕ Donate
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              Loom is a free, ad-free research project — dual-language subtitles
              with romanization for anyone learning a language through video. If
              it&rsquo;s been useful to you, a small tip helps cover the hosting
              that keeps the romanization API running and funds new features.
              Entirely optional, always appreciated.
            </p>

            {METHODS.length > 0 ? (
              <div className="mt-12 flex flex-wrap justify-center gap-6">
                {METHODS.map((method) => (
                  <MethodCard key={method.name} method={method} />
                ))}
              </div>
            ) : (
              <p className="mt-12 rounded-lg border border-border/60 bg-background/40 p-6 text-sm text-muted-foreground">
                Tip links are being set up — check back shortly.
              </p>
            )}

            <p className="mt-10 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Prefer to contribute in other ways? Loom is open source —
              bug reports and ideas at{" "}
              <Link
                href="https://github.com/Beyond-InFinnity/Loom/issues"
                rel="noopener noreferrer"
                target="_blank"
                className="text-primary hover:underline"
              >
                GitHub Issues
              </Link>{" "}
              are just as valuable.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
