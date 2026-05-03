import type { NextConfig } from "next";

// ffmpeg.wasm requires SharedArrayBuffer, which browsers gate behind
// cross-origin isolation.  COEP=require-corp + COOP=same-origin enables
// the secure context.  These headers must apply to every route that
// loads the wasm worker, so we attach them globally.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
