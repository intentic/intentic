#!/usr/bin/env node
// Pins the desk skin's palette to the app's light theme.
//
// styles/desk.css claims to BE the app's light scheme rather than a second light design that resembles it. Nothing in
// the build enforces that: the two live in different packages, behind different Tailwind themes, and a change to the
// app's ramp or its light recipes would leave the site quietly a shade off — the kind of drift nobody sees in a diff
// and everybody sees in a screenshot six months later. This reads both files and fails if they have parted.
//
// It checks four things:
//   1. every ramp step desk copies still has the app's value,
//   2. every role desk rebuilds still uses the app's recipe, mix for mix,
//   3. the one place a colour had to be hardcoded (the plate's scrim, which needs a bare RGB triple) still equals the
//      canvas it claims to be,
//   4. the light shadow tint and the terminal ground are the app's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = resolve(root, "../../_editor/ui/src/styles");

const primitives = readFileSync(resolve(app, "primitive-colors.css"), "utf8");
const semantics = readFileSync(resolve(app, "semantic-colors.css"), "utf8");
const desk = readFileSync(resolve(root, "src/styles/desk.css"), "utf8");

const failures = [];
const fail = (what, expected, actual) => failures.push(`${what}\n    app  : ${expected}\n    desk : ${actual}`);

/** Collapses the cosmetic differences between two hand-formatted stylesheets: run-together spaces, trailing zeros. */
const normalise = (value) =>
    value
        .replace(/\s+/gu, " ")
        .replace(/\(\s+/gu, "(")
        .replace(/\s+\)/gu, ")")
        .replace(/(\.\d*[1-9])0+(?!\d)/gu, "$1")
        .trim();

/** Reads a declaration out of a stylesheet. `scope` limits the search to one rule, for files that define a name twice. */
const decl = (css, name, scope) => {
    const text = scope === undefined ? css : (new RegExp(`${scope}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "");
    const match = new RegExp(`(?:^|;|\\{)\\s*${name}\\s*:\\s*([^;]+);`, "mu").exec(text);
    return match === null ? undefined : normalise(match[1]);
};

// The app's light scheme is its `:root`; its dark scheme is the `[data-mode="dark"]` block below it.
const appLight = semantics.slice(0, semantics.indexOf('[data-mode="dark"]'));
const appLightRole = (name) => decl(appLight, name);
const deskDecl = (name) => decl(desk, name);

// ── 1. ramp steps ────────────────────────────────────────────────────────────────────────────────────────────────
// Desk copies these under its own prefix so the site's `--color-*: initial` reset cannot reach them.
const RAMP = { neutral: [0, 50, 100, 200, 300, 500, 600, 900], brand: [300, 500, 600, 700, 800, 900, 950], green: [700], amber: [800], red: [700] };
for (const [family, steps] of Object.entries(RAMP)) {
    for (const step of steps) {
        const expected = decl(primitives, `--color-${family}-${step}`);
        const actual = deskDecl(`--desk-${family}-${step}`);
        if (expected === undefined) {
            fail(`--color-${family}-${step} is gone from the app's ramp`, "(missing)", actual ?? "(missing)");
        } else if (expected !== actual) {
            fail(`ramp step --desk-${family}-${step}`, expected, actual ?? "(missing)");
        }
    }
}

// ── 2. roles ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The app spells its recipes in its own vocabulary: `surface` aliases neutral, `primary` aliases brand, and the light
// scheme stirs everything with `--paper-tint`. Rewriting those into desk's names is what makes the two comparable.
const toDeskNames = (value) =>
    value
        .replace(/var\(--paper-tint\)/gu, "var(--desk-brand-300)")
        .replace(/var\(--color-surface-(\d+)\)/gu, "var(--desk-neutral-$1)")
        .replace(/var\(--color-(?:brand|primary)-(\d+)\)/gu, "var(--desk-brand-$1)")
        .replace(/var\(--color-danger-(\d+)\)/gu, "var(--desk-red-$1)")
        .replace(/var\(--color-success-(\d+)\)/gu, "var(--desk-green-$1)")
        .replace(/var\(--color-warning-(\d+)\)/gu, "var(--desk-amber-$1)")
        .replace(/var\(--color-white\)/gu, "#fff")
        .replace(/var\(--ui-shadow-tint\)/gu, "var(--desk-shadow-tint)");

// Left: the app's light role. Right: what desk.css calls the same thing. The names differ because the site's token
// vocabulary is its own — it has gold and a bronze button where the app has a link and a filled control.
const ROLES = [
    ["--role-canvas", "--color-canvas"],
    ["--role-card", "--color-card"],
    ["--role-overlay", "--color-overlay"],
    ["--role-line", "--color-line"],
    ["--role-line-strong", "--color-line-strong"],
    ["--role-content", "--color-content"],
    ["--role-muted", "--color-muted"],
    ["--role-subtle", "--color-subtle"],
    // The site's prose link is its brighter metal; the app's is `--role-link`, and they must be the same step.
    ["--role-link", "--color-gold-bright"],
    ["--role-danger", "--color-danger"],
    ["--role-success", "--color-success"],
    ["--role-warning", "--color-warning"],
    // The primary button is NOT pinned to the app's filled control. It is the house's cast-gold plaque in both
    // skins — the one place the site deliberately keeps its own material rather than borrowing the app's — so
    // there is nothing here for the app to drift away from.
    // A terminal is paper on both, and the same paper.
    ["--role-terminal", "--role-code-fill"],
    ["--role-terminal", "--role-figure-terminal"],
    ["--ui-shadow-tint", "--desk-shadow-tint"],
    ["--ui-shadow-1", "--desk-shadow-1"],
    ["--ui-shadow-2", "--desk-shadow-2"],
    ["--ui-shadow-3", "--desk-shadow-3"],
];
for (const [appName, deskName] of ROLES) {
    const expected = appLightRole(appName);
    const actual = deskDecl(deskName);
    if (expected === undefined) {
        fail(`${appName} is gone from the app's light scheme`, "(missing)", actual ?? "(missing)");
    } else if (normalise(toDeskNames(expected)) !== actual) {
        fail(`${deskName} no longer matches the app's ${appName}`, normalise(toDeskNames(expected)), actual ?? "(missing)");
    }
}

// ── 3. the hardcoded scrim ───────────────────────────────────────────────────────────────────────────────────────
// The plate's gradients set their own alpha per stop, so the paper they wash toward has to be a bare `R G B` triple
// that `rgb()` can take a slash-alpha on. That is the one colour in desk.css a browser resolves and this file cannot,
// so it is resolved here: OKLCh through OKLab to sRGB, the same arithmetic the browser does for `color-mix`.
const oklch = (value) => {
    const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/u.exec(value);
    if (m === null) {return undefined;}
    const [L, C, h] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
    return [L, C * Math.cos(h), C * Math.sin(h)];
};
const toSrgb = ([L, a, b]) => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map((c) => Math.round(Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) * 255));
};

const canvasRecipe = /color-mix\(in oklab, var\((--desk-[\w-]+)\) (\d+)%, var\((--desk-[\w-]+)\)\)/u.exec(deskDecl("--color-canvas") ?? "");
if (canvasRecipe === null) {
    fail("--color-canvas is no longer a two-part oklab mix, so the scrim cannot be checked against it", "color-mix(...)", deskDecl("--color-canvas") ?? "(missing)");
} else {
    const [, baseName, percent, tintName] = canvasRecipe;
    const base = oklch(deskDecl(baseName) ?? "");
    const tint = oklch(deskDecl(tintName) ?? "");
    if (base === undefined || tint === undefined) {
        fail("the canvas recipe's ingredients are no longer plain oklch(), so the scrim cannot be checked", `${baseName} / ${tintName}`, "(unparsed)");
    } else {
        const weight = Number(percent) / 100;
        const expected = toSrgb(base.map((v, i) => v * weight + tint[i] * (1 - weight))).join(" ");
        const actual = deskDecl("--role-scrim");
        if (expected !== actual) {
            fail("--role-scrim is meant to be --color-canvas resolved to sRGB", expected, actual ?? "(missing)");
        }
    }
}

if (failures.length > 0) {
    console.error(
        `desk palette has drifted from the app's light theme (${failures.length} ${failures.length === 1 ? "difference" : "differences"}).\n` +
            `  app  : _editor/ui/src/styles/{primitive,semantic}-colors.css\n` +
            `  desk : _site/site/src/styles/desk.css\n\n` +
            `${failures.join("\n\n")}\n\n` +
            `Copy the app's values across, or if the app moved on purpose, move desk.css with it.`,
    );
    process.exit(1);
}
console.log(`desk palette matches the app's light theme: ${Object.values(RAMP).flat().length} ramp steps, ${ROLES.length} roles, and the plate's scrim.`);
