import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Dev-server origin allow-list.
   *
   * `next dev` refuses to serve `/_next/*` assets to origins it does not know,
   * and the hosted sandbox preview is served from `<port>-<sandbox>.e2b.app`.
   * Without this the page loads but its scripts 403, which looks like a broken
   * app. This setting has no effect on `next build` / `next start` output.
   */
  allowedDevOrigins: ["*.e2b.app"],
};

export default nextConfig;
