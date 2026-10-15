import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    /**
     * One test file at a time. The sandbox database (PGlite behind a wire-protocol
     * socket server) serves EVERY logical connection from ONE backend session, so
     * two files running in parallel share transaction state — `savepoint`,
     * role switching and open transactions leak between connections, which is
     * exactly the class of flakiness these suites must not be judged by
     * (TESTING_AND_ACCEPTANCE §2). Against a real PostgreSQL server file
     * parallelism is safe again; here it buys ~1 s and risks false results.
     */
    fileParallelism: false,
  },
});
