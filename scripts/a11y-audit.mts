/**
 * Phase 10 — accessibility audit of the *rendered* screens, not of the source files.
 *
 * `tests/unit/a11y-tokens.test.ts` checks the colour maths; this checks the markup that actually
 * reaches a browser. It mints two *test* sessions (the same rows a login would insert), walks every
 * tenant screen, every console screen and the public ones, then reads each document back as a tree
 * and asks the questions a screen reader or a keyboard user would ask:
 *
 *   - does the document declare its language and direction (`<html lang="ar" dir="rtl">`)?
 *   - is there exactly one h1, and does the heading order ever skip a level?
 *   - does every control have a name (a wrapping label, `aria-label`, or a `title`)? A placeholder
 *     is not a name: it disappears the moment the operator types.
 *   - does every button and link have an accessible name? An icon-only button without one is
 *     announced as "button".
 *   - is anything focusable hidden from assistive technology (`aria-hidden="true"` around a link)?
 *   - is the tab order natural (no `tabindex` above 0)?
 *   - does every table have header cells, so a value read aloud has a column?
 *   - are ids unique (they are what `label[for]` and `aria-labelledby` point at)?
 *   - is a status carried by colour *alone*, or does the coloured chip also say something?
 *
 * Usage (the dev server must be running):
 *   npx tsx scripts/a11y-audit.mts [--base=http://127.0.0.1:3000] [--verbose]
 *
 * Exit code 0 = no violation on any screen; 1 = at least one, listed with the page it was seen on.
 */

import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const BASE = arg("base", process.env.ACCEPTANCE_BASE ?? "http://127.0.0.1:3000");
const VERBOSE = process.argv.includes("--verbose");

const TENANT_ROUTES = [
  "/dashboard",
  "/accounting",
  "/inventory",
  "/sales",
  "/purchasing",
  "/cash",
  "/pos",
  "/manufacturing",
  "/settlement",
  "/tax",
  "/reports",
  "/assistant",
  "/assistant/settings",
  "/rep",
  "/rep/pos",
  "/rep/settle",
  "/rep/transfers",
  "/rep/sync",
];

const PLATFORM_ROUTES = [
  "/platform",
  "/platform/tenants",
  "/platform/plans",
  "/platform/flags",
  "/platform/alerts",
  "/platform/backups",
  "/platform/exports",
  "/platform/audit",
];

const PUBLIC_ROUTES = ["/login", "/platform/login"];

// ── a tolerant HTML reader ──────────────────────────────────────────────────────────────────────
// Enough of a parser to reason about structure: tags with attributes, nesting, and text. It is not
// a browser — no tag repair, no implied tbody — but the app's own markup is well formed, and every
// question below is about structure that React emitted, not about how a browser would fix it up.

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: Node | null;
  text: string;
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TAGS = new Set(["script", "style", "template"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

const decode = (value: string) =>
  value.replace(/&(#?x?[0-9a-z]+);/gi, (whole, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole);

/** Index of the `>` that closes the tag starting at `lt` — ignoring `>` inside quoted values. */
function tagEnd(html: string, lt: number): number {
  let quote: string | null = null;
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return html.length - 1;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const [, name, dq, sq, bare] = match;
    attrs[name!.toLowerCase()] = decode(dq ?? sq ?? bare ?? "");
  }
  return attrs;
}

function parseHtml(html: string): Node {
  const root: Node = { tag: "#document", attrs: {}, children: [], parent: null, text: "" };
  let current = root;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      current.text += html.slice(i);
      break;
    }
    if (lt > i) current.text += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      i = tagEnd(html, lt) + 1;
      continue;
    }
    const gt = tagEnd(html, lt);
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      let node: Node | null = current;
      while (node && node.tag !== name) node = node.parent;
      if (node?.parent) current = node.parent;
      continue;
    }
    const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1]!.toLowerCase();
    const attrs = parseAttrs(raw.slice(nameMatch[1]!.length));
    const node: Node = { tag, attrs, children: [], parent: current, text: "" };
    current.children.push(node);
    if (RAW_TAGS.has(tag)) {
      // the content of a script/style is not markup: jump past its closing tag
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      i = close < 0 ? html.length : tagEnd(html, close) + 1;
      continue;
    }
    if (!VOID_TAGS.has(tag) && !raw.trimEnd().endsWith("/")) current = node;
  }
  return root;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function textOf(node: Node): string {
  let text = node.text;
  for (const child of node.children) text += textOf(child);
  return decode(text).replace(/\s+/g, " ").trim();
}

/** The name a screen reader would announce for this element. */
function accessibleName(node: Node): string {
  if (node.attrs["aria-label"]) return node.attrs["aria-label"].trim();
  if (node.attrs["aria-labelledby"]) {
    const ids = node.attrs["aria-labelledby"].split(/\s+/);
    let found = "";
    walk(root, (candidate) => {
      if (ids.includes(candidate.attrs.id ?? "") && !found) found = textOf(candidate);
    });
    if (found) return found;
  }
  if (node.attrs.title) return node.attrs.title.trim();
  const text = textOf(node);
  if (text) return text;
  // a link is named by its image's alt text
  const alt = (node.children.find((c) => c.tag === "img")?.attrs.alt ?? "").trim();
  return alt;
}

const FOCUSABLE = (node: Node) =>
  (node.tag === "a" && Boolean(node.attrs.href)) ||
  node.tag === "button" ||
  (node.tag === "input" && node.attrs.type !== "hidden") ||
  node.tag === "select" ||
  node.tag === "textarea" ||
  (node.attrs.tabindex !== undefined && node.attrs.tabindex !== "-1");

// ── sessions: the rows a successful login inserts, revoked afterwards ───────────────────────────

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const db = new Client({ connectionString: process.env.DATABASE_URL! });
await db.connect();

const tenantUser = (
  await db.query(`select u.id, u.tenant_id from users u join tenants t on t.id = u.tenant_id
                  where t.status in ('trial','active') order by u.created_at limit 1`)
).rows[0];
// Any active console operator will do: enrolment is enforced when an operator *signs in*, not on a
// row minted here, so the audit never depends on someone having a phone at hand.
const platformUser = (
  await db.query(`select id from platform_users where status = 'active' order by created_at limit 1`)
).rows[0];

if (!tenantUser || !platformUser) {
  console.error("no active platform user or tenant user to probe with — run `npm run db:seed`");
  process.exit(1);
}

const sessionIds: string[] = [];
const mint = async (columns: { user_id?: string; platform_user_id?: string; tenant_id?: string }, raw: string) => {
  const id = randomUUID();
  await db.query(
    `insert into sessions (id, user_id, platform_user_id, tenant_id, token_hash, expires_at, created_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, now() + interval '20 minutes', now())`,
    [id, columns.user_id ?? null, columns.platform_user_id ?? null, columns.tenant_id ?? null, sha256(raw)],
  );
  sessionIds.push(id);
};

const tenantToken = `a11y-${randomUUID()}`;
const platformToken = `a11y-${randomUUID()}`;
await mint({ user_id: tenantUser.id, tenant_id: tenantUser.tenant_id }, tenantToken);
await mint({ platform_user_id: platformUser.id }, platformToken);

// ── the audit ───────────────────────────────────────────────────────────────────────────────────

interface Violation {
  rule: string;
  where: string;
  detail: string;
}

const violations: Violation[] = [];
const screens: string[] = [];
let root: Node = { tag: "#document", attrs: {}, children: [], parent: null, text: "" };

const fail = (rule: string, where: string, detail: string) => violations.push({ rule, where, detail });

function auditScreen(route: string, html: string) {
  root = parseHtml(html);
  screens.push(route);
  const where = route;

  // 1. language and direction
  const htmlTag = root.children.find((c) => c.tag === "html");
  if (!htmlTag) return fail("no <html>", where, "document has no html element");
  if (!htmlTag.attrs.lang) fail("lang missing", where, "<html> does not declare a language");
  if (htmlTag.attrs.dir !== "rtl") fail("direction", where, `<html dir="${htmlTag.attrs.dir ?? "—"}">, expected rtl`);

  // 2. headings: one h1, no skipped level
  const headings: { level: number; text: string }[] = [];
  walk(root, (node) => {
    const match = /^h([1-6])$/.exec(node.tag);
    if (match) headings.push({ level: Number(match[1]), text: textOf(node).slice(0, 40) });
  });
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) fail("no h1", where, "the screen has no first-level heading");
  if (h1s.length > 1) fail("many h1", where, `${h1s.length} first-level headings: ${h1s.map((h) => h.text).join(" | ")}`);
  let previous = 0;
  for (const heading of headings) {
    if (previous && heading.level > previous + 1) {
      fail("heading level", where, `h${previous} → h${heading.level} ("${heading.text}") skips a level`);
    }
    previous = heading.level;
  }

  const ids = new Map<string, number>();
  walk(root, (node) => {
    // 3. images need alternative text
    if (node.tag === "img" && !node.attrs["aria-hidden"] && node.attrs.alt === undefined) {
      fail("image alt", where, `<img src="${node.attrs.src ?? "?"}"> has no alt`);
    }

    // 4. form controls need a name
    const isControl =
      (node.tag === "input" && !["hidden", "submit", "button", "reset", "image"].includes(node.attrs.type ?? "text")) ||
      node.tag === "select" ||
      node.tag === "textarea";
    if (isControl) {
      let labelledByWrapper = false;
      for (let up = node.parent; up; up = up.parent) if (up.tag === "label") labelledByWrapper = true;
      let labelledByFor = false;
      if (node.attrs.id) {
        walk(root, (candidate) => {
          if (candidate.tag === "label" && candidate.attrs.for === node.attrs.id) labelledByFor = true;
        });
      }
      const named = labelledByWrapper || labelledByFor || Boolean(node.attrs["aria-label"] || node.attrs["aria-labelledby"] || node.attrs.title);
      if (!named) {
        const hint = node.attrs.placeholder ? ` (only a placeholder: "${node.attrs.placeholder}")` : "";
        fail("control name", where, `<${node.tag} name="${node.attrs.name ?? "?"}"> has no label${hint}`);
      }
    }

    // 5. buttons and links need an accessible name
    if ((node.tag === "button" || node.tag === "a") && (node.tag === "button" || node.attrs.href)) {
      if (!accessibleName(node)) {
        fail("interactive name", where, `<${node.tag}> is announced with no name`);
      }
    }

    // 6. the tab order must be the document order
    const tabindex = Number(node.attrs.tabindex ?? "0");
    if (node.attrs.tabindex !== undefined && tabindex > 0) {
      fail("tabindex", where, `<${node.tag} tabindex="${node.attrs.tabindex}"> forces its own tab position`);
    }

    // 7. nothing focusable may be hidden from assistive technology
    if (node.attrs["aria-hidden"] === "true") {
      walk(node, (inner) => {
        if (inner !== node && FOCUSABLE(inner)) {
          fail("hidden focusable", where, `<${inner.tag}> is focusable inside aria-hidden="true"`);
        }
      });
    }

    // 8. tables need header cells
    if (node.tag === "table") {
      let headers = 0;
      walk(node, (inner) => {
        if (inner.tag === "th") headers++;
      });
      if (headers === 0) fail("table headers", where, "a table has no <th>");
    }

    // 9. ids are unique — they are what labels and aria references point at
    if (node.attrs.id) ids.set(node.attrs.id, (ids.get(node.attrs.id) ?? 0) + 1);

    // 10. meaning may not be carried by colour alone. A tinted chip is fine when it also *says*
    // something (text, or an icon whose shape carries the meaning); a bare tinted box is not —
    // and `hover:`/`focus:` variants are not a state the reader is looking at.
    const classes = (node.attrs.class ?? "").split(/\s+/).filter((c) => c && !c.includes(":"));
    if (classes.some((c) => /^bg-(success|warning|danger|info)-soft$/.test(c)) && node.children.length > 0) {
      let icon = false;
      walk(node, (inner) => {
        if (inner.tag === "svg" || inner.tag === "img") icon = true;
      });
      if (!textOf(node) && !icon) {
        fail("colour only", where, `<${node.tag} class="${classes.join(" ").slice(0, 40)}"> shows a state with no text`);
      }
    }
  });

  for (const [id, count] of ids) {
    if (count > 1) fail("duplicate id", where, `id="${id}" appears ${count} times`);
  }
}

const get = async (route: string, cookie?: string) => {
  const response = await fetch(`${BASE}${route}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, html: await response.text() };
};

console.log(`\nA11Y AUDIT  ·  ${BASE}\n`);

for (const route of PUBLIC_ROUTES) {
  const { status, html } = await get(route);
  if (status !== 200) fail("unreachable", route, `HTTP ${status}`);
  else auditScreen(route, html);
}
for (const route of TENANT_ROUTES) {
  const { status, html } = await get(route, `hisab_session=${tenantToken}`);
  if (status !== 200) fail("unreachable", route, `HTTP ${status} with a tenant session`);
  else auditScreen(route, html);
}
for (const route of PLATFORM_ROUTES) {
  const { status, html } = await get(route, `hisab_platform_session=${platformToken}`);
  if (status !== 200) fail("unreachable", route, `HTTP ${status} with a console session`);
  else auditScreen(route, html);
}

// ── the report ──────────────────────────────────────────────────────────────────────────────────

const byRule = new Map<string, Violation[]>();
for (const violation of violations) {
  byRule.set(violation.rule, [...(byRule.get(violation.rule) ?? []), violation]);
}

console.log(`── ${screens.length} screens read as documents ───`);
const RULES = [
  "unreachable", "no <html>", "lang missing", "direction", "no h1", "many h1", "heading level",
  "image alt", "control name", "interactive name", "tabindex", "hidden focusable",
  "table headers", "duplicate id", "colour only",
];
for (const rule of RULES) {
  const found = byRule.get(rule) ?? [];
  console.log(`${found.length === 0 ? "✓" : "✗"} ${rule.padEnd(20)} ${found.length === 0 ? "clean" : `${found.length} violation${found.length === 1 ? "" : "s"}`}`);
}

if (violations.length > 0) {
  console.log("\n── what to fix ───");
  for (const [rule, found] of byRule) {
    console.log(`\n${rule}:`);
    const shown = VERBOSE ? found : found.slice(0, 6);
    for (const violation of shown) console.log(`  ${violation.where.padEnd(24)} ${violation.detail}`);
    if (!VERBOSE && found.length > shown.length) console.log(`  … and ${found.length - shown.length} more (--verbose)`);
  }
}

// leave nothing behind: the probe's sessions go, and the audit was never a login
for (const id of sessionIds) await db.query(`delete from sessions where id = $1::uuid`, [id]);
await db.end();

if (violations.length === 0) {
  console.log(`\nA11Y AUDIT PASSED — ${screens.length} screens, no violations\n`);
  process.exit(0);
}
console.log(`\nA11Y AUDIT FAILED — ${violations.length} violations across ${new Set(violations.map((v) => v.where)).size} screens\n`);
process.exit(1);
