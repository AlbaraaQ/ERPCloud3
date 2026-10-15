/**
 * Edge-safe auth constants — NO Node-only imports allowed here
 * (imported by middleware, which runs in the edge runtime).
 */

export const SESSION_COOKIE = "hisab_session";
