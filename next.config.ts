import type { NextConfig } from "next";

/**
 * Hosts that may POST a Server Action, derived from the environment.
 *
 * WHY THIS IS NEEDED — the bug this config exists for. In the hosted preview the browser
 * talks to `https://<port>-<sandbox>.e2b.app` and the proxy forwards the request to the app
 * with `host`/`x-forwarded-host` set to the **upstream** address. Next.js refuses a Server
 * Action whose `Origin` does not match the forwarded host, with
 * "Invalid Server Actions request." — so every form in the app (login first) returned a 500
 * for a real user in the preview while working perfectly on `localhost`.
 *
 * `serverActions.allowedOrigins` is the supported escape hatch. The default below covers the
 * sandbox preview wildcard; a real deployment should either rely on same-origin requests
 * (no entry needed when the proxy forwards the public host) or set `HISAB_ALLOWED_ORIGINS`
 * to its own host(s), comma-separated, e.g. `hisab.example.com,*.internal.example.com`.
 */
const allowedOrigins = (process.env.HISAB_ALLOWED_ORIGINS ?? "*.e2b.app,localhost:3000,127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  /**
   * Dev-server origin allow-list.
   *
   * `next dev` refuses to serve `/_next/*` assets to origins it does not know,
   * and the hosted sandbox preview is served from `<port>-<sandbox>.e2b.app`.
   * Without this the page loads but its scripts 403, which looks like a broken
   * app. This setting has no effect on `next build` / `next start` output.
   */
  allowedDevOrigins: ["*.e2b.app", "localhost", "127.0.0.1"],
  experimental: {
    /**
     * Same idea, for Server Actions (POSTs) rather than assets. Keep this list
     * identical to `allowedDevOrigins` so the preview cannot half-work: assets fine,
     * forms 500. Regression probe: `npm run login:probe`.
     */
    serverActions: { allowedOrigins },
  },
};

export default nextConfig;
