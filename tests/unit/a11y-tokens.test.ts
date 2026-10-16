/**
 * Contrast of the design tokens (Phase 10 — the AA half of the screen audit).
 *
 * Every colour in this app comes from `src/app/globals.css`, and the pairs below are the ones the
 * screens actually put on top of each other (a badge is `text-warning` on `bg-warning-soft`, the
 * sidebar is `text-muted` on `bg-surface-2`, and so on). Reading the file rather than a copy of the
 * values means a token can never be lightened for looks without failing a test that says what it
 * costs:
 *
 *   - text pairs       >= 4.5 : 1   (WCAG 1.4.3; the UI is mostly 11–14 px, so nothing is "large")
 *   - focus ring       >= 3.0 : 1   (WCAG 1.4.11 — the ring is the only focus indication)
 *   - form-control edge >= 3.0 : 1  (WCAG 1.4.11 — a control filled like the card behind it is
 *                                    identified by its outline alone)
 *
 * Decorative hairlines (`--border` on cards, table rows, list separators) are *not* in this list:
 * they carry no meaning, so WCAG's non-text contrast does not apply to them — and darkening them
 * to 3:1 would turn a quiet interface into a grid of boxes.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");

/** The custom properties declared in one theme block. */
function tokens(block: RegExp): Record<string, string> {
  const match = block.exec(css);
  if (!match) throw new Error(`no theme block matching ${block}`);
  return Object.fromEntries(
    [...match[1]!.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]),
  );
}

const LIGHT = tokens(/:root\s*\{([\s\S]*?)\n\}/);
const DARK = tokens(/\.dark\s*\{([\s\S]*?)\n\}/);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function ratio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Text the operator reads, on the surface it is read from. */
const TEXT_PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["foreground", "surface"],
  ["foreground", "surface-2"],
  ["foreground", "surface-3"],
  ["muted", "background"],
  ["muted", "surface"],
  ["muted", "surface-2"],
  ["muted", "surface-3"],
  ["primary", "surface"],
  ["primary", "surface-2"],
  ["primary-foreground", "primary"],
  ["primary-foreground", "primary-hover"],
  ["success", "surface"],
  ["success", "success-soft"],
  ["warning", "surface"],
  ["warning", "warning-soft"],
  ["danger", "surface"],
  ["danger", "danger-soft"],
  ["info", "surface"],
  ["info", "info-soft"],
];

/** The ring is drawn against whatever is behind it: the white card or the page tint. */
const RING_BACKDROPS = ["surface", "surface-2", "background"];
const CONTROL_BACKDROPS = ["surface", "surface-2", "background"];

describe.each([
  ["light", LIGHT],
  ["dark", DARK],
])("%s theme", (name, theme) => {
  it.each(TEXT_PAIRS)("%s on %s meets 4.5:1", (fg, bg) => {
    const value = ratio(theme[fg]!, theme[bg]!);
    // the message prints the ratio, so a regression says how far off it is
    expect(value, `${fg} on ${bg} = ${value.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(RING_BACKDROPS)("the focus ring is visible on %s (3:1)", (bg) => {
    expect(ratio(theme["ring"]!, theme[bg]!), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it.each(CONTROL_BACKDROPS)("a form control's outline separates it from %s (3:1)", (bg) => {
    expect(ratio(theme["input"]!, theme[bg]!), `input on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it("has both themes fully populated", () => {
    for (const key of ["background", "surface", "foreground", "muted", "primary", "input", "ring"]) {
      expect(theme[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

/** Hue in degrees, so two "dark reds" can be told apart as colours rather than as brightnesses. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  const raw = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((raw * 60) % 360 + 360) % 360;
}

describe("the design system keeps its own meanings apart", () => {
  it("does not paint a warning in the failure's colour", () => {
    // warning #92400e and danger #b91c1c are both dark reds; an 11 px badge whose text is easy to
    // miss must still be told apart by hue, so the two are held at least 20 degrees apart
    expect(LIGHT["warning"]).not.toBe(LIGHT["danger"]);
    expect(Math.abs(hue(LIGHT["warning"]!) - hue(LIGHT["danger"]!))).toBeGreaterThanOrEqual(20);
    expect(Math.abs(hue(LIGHT["success"]!) - hue(LIGHT["danger"]!))).toBeGreaterThanOrEqual(20);
  });

  it("keeps the two themes' meanings aligned", () => {
    // amber-800 in the light theme and amber-400 in the dark one are the same meaning at different
    // lightnesses; the tolerance is wide enough for a tint, far too narrow for a different family
    for (const tone of ["success", "warning", "danger", "info"]) {
      expect(Math.abs(hue(LIGHT[tone]!) - hue(DARK[tone]!)), tone).toBeLessThanOrEqual(30);
    }
  });

  it("states its own rules in the file, where the values are", () => {
    expect(css).toContain("WCAG 1.4.11");
    expect(css).toMatch(/--input: #[0-9a-f]{6}/);
  });
});
