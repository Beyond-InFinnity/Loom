import type { NextConfig } from "next";

// ffmpeg.wasm requires SharedArrayBuffer, which browsers gate behind
// cross-origin isolation.  COEP=credentialless + COOP=same-origin enables
// the secure context while still allowing cross-origin fetches without
// credentials (no CORP requirement on responses).  This matters because
// the API lives at a different origin (localhost:8765 in dev,
// api.loom.nerv-analytic.ai in prod) and we don't want to require
// CORP middleware on every API endpoint.  Trade-off: Safari support
// for credentialless is still partial — that's an acceptable gap.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
