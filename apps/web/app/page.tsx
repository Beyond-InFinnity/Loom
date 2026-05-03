export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-zinc-50 p-8 font-sans dark:bg-black">
      <h1 className="text-4xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
        Loom
      </h1>
      <p className="max-w-md text-center text-lg text-zinc-600 dark:text-zinc-400">
        Multilingual subtitle generator.  Web UI under construction — see
        <code className="mx-1">/ffmpeg-test</code> for the current
        scaffolding.
      </p>
    </main>
  );
}
