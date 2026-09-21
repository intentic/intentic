#!/usr/bin/env node
// Pins the maker skin's palette to the app's light theme.
//
// styles/maker.css claims to BE the app's light scheme rather than a second light design that resembles it. Nothing in
// the build enforces that: the two live in different packages, behind different Tailwind themes, and a change to the
// app's ramp or its light recipes would leave the site quietly a shade off — the kind of drift nobody sees in a diff
// and everybody sees in a screenshot six months later. This reads both files and fails if they have parted.
//
// It checks four things:
//   1. every ramp step maker copies still has the app's value,
//   2. every role maker rebuilds still uses the app's recipe, mix for mix,
//   3. the one place a colour had to be hardcoded (the plate's scrim, which needs a bare RGB triple) still equals the
//      canvas it claims to be,
//   4. the light shadow tint and the terminal ground are the app's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = resolve(root, "../../_editor/ui/src/styles");

const primitives = readFileSync(resolve(app, "primitive-colors.css"), "utf8");
const semantics = readFileSync(resolve(app, "semantic-colors.css"), "utf8");
const maker = readFileSync(resolve(root, "src/styles/maker.css"), "utf8");
const entry = readFileSync(resolve(root, "../../_shared/entry-css/entry.css"), "utf8");

const failures = [];
const fail = (what, expected, actual) => failures.push(`${what}\n    app  : ${expected}\n    maker : ${actual}`);

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
const homeDecl = (name) => decl(maker, name);

// ── 1. ramp steps ────────────────────────────────────────────────────────────────────────────────────────────────
// Maker copies these under its own prefix so the site's `--color-*: initial` reset cannot reach them.
const RAMP = { neutral: [0, 50, 100, 200, 300, 500, 600, 900], brand: [300, 500, 600, 700, 800, 900, 950], green: [700], amber: [800], red: [700] };
for (const [family, steps] of Object.entries(RAMP)) {
    for (const step of steps) {
        const expected = decl(primitives, `--color-${family}-${step}`);
        const actual = homeDecl(`--maker-${family}-${step}`);
        if (expected === undefined) {
            fail(`--color-${family}-${step} is gone from the app's ramp`, "(missing)", actual ?? "(missing)");
        } else if (expected !== actual) {
            fail(`ramp step --maker-${family}-${step}`, expected, actual ?? "(missing)");
        }
    }
}

// ── 2. roles ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The app spells its recipes in its own vocabulary: `surface` aliases neutral, `primary` aliases brand, and the light
// scheme stirs everything with `--paper-tint`. Rewriting those into maker's names is what makes the two comparable.
const toGuestNames = (value) =>
    value
        .replace(/var\(--paper-tint\)/gu, "var(--maker-brand-300)")
        .replace(/var\(--color-surface-(\d+)\)/gu, "var(--maker-neutral-$1)")
        .replace(/var\(--color-(?:brand|primary)-(\d+)\)/gu, "var(--maker-brand-$1)")
        .replace(/var\(--color-danger-(\d+)\)/gu, "var(--maker-red-$1)")
        .replace(/var\(--color-success-(\d+)\)/gu, "var(--maker-green-$1)")
        .replace(/var\(--color-warning-(\d+)\)/gu, "var(--maker-amber-$1)")
        .replace(/var\(--color-white\)/gu, "#fff")
        .replace(/var\(--ui-shadow-tint\)/gu, "var(--maker-shadow-tint)");

// Left: the app's light role. Right: what maker.css calls the same thing. The names differ because the site's token
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
    ["--ui-shadow-tint", "--maker-shadow-tint"],
    ["--ui-shadow-1", "--maker-shadow-1"],
    ["--ui-shadow-2", "--maker-shadow-2"],
    ["--ui-shadow-3", "--maker-shadow-3"],
];
for (const [appName, makerName] of ROLES) {
    const expected = appLightRole(appName);
    const actual = homeDecl(makerName);
    if (expected === undefined) {
        fail(`${appName} is gone from the app's light scheme`, "(missing)", actual ?? "(missing)");
    } else if (normalise(toGuestNames(expected)) !== actual) {
        fail(`${makerName} no longer matches the app's ${appName}`, normalise(toGuestNames(expected)), actual ?? "(missing)");
    }
}

// ── 3. the hardcoded scrim ───────────────────────────────────────────────────────────────────────────────────────
// The plate's gradients set their own alpha per stop, so the paper they wash toward has to be a bare `R G B` triple
// that `rgb()` can take a slash-alpha on. That is the one colour in maker.css a browser resolves and this file cannot,
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

const canvasRecipe = /color-mix\(in oklab, var\((--maker-[\w-]+)\) (\d+)%, var\((--maker-[\w-]+)\)\)/u.exec(homeDecl("--color-canvas") ?? "");
if (canvasRecipe === null) {
    fail("--color-canvas is no longer a two-part oklab mix, so the scrim cannot be checked against it", "color-mix(...)", homeDecl("--color-canvas") ?? "(missing)");
} else {
    const [, baseName, percent, tintName] = canvasRecipe;
    const base = oklch(homeDecl(baseName) ?? "");
    const tint = oklch(homeDecl(tintName) ?? "");
    if (base === undefined || tint === undefined) {
        fail("the canvas recipe's ingredients are no longer plain oklch(), so the scrim cannot be checked", `${baseName} / ${tintName}`, "(unparsed)");
    } else {
        const weight = Number(percent) / 100;
        const expected = toSrgb(base.map((v, i) => v * weight + tint[i] * (1 - weight))).join(" ");
        const actual = homeDecl("--role-scrim");
        if (expected !== actual) {
            fail("--role-scrim is meant to be --color-canvas resolved to sRGB", expected, actual ?? "(missing)");
        }
    }
}

// ── 4. the entry screens ─────────────────────────────────────────────────────────────────────────────────────────
// /login and /setup are the site's design worn by the app, so a reader arriving from /maker meets them in the light
// skin too — and they carry their own copy of the house materials, in a third package, behind a third selector. Only
// the house metals are copied: everything else in that block hands the app's own light roles back, which cannot drift
// from the app by construction. maker.css spells its bevels with `--maker-shadow-*`, which do not exist over there, so
// they are expanded before the two are compared.
const entryBlock = /html:not\(\[data-mode="dark"\]\) \.entry \{([^}]*)\}/u.exec(entry)?.[1];
if (entryBlock === undefined) {
    fail("entry.css has no light block, so /login and /setup arrive dark for a reader who came from /maker", 'html:not([data-mode="dark"]) .entry { … }', "(missing)");
} else {
    const expandShadows = (value) =>
        normalise(
            value
                .replace(/var\((--maker-shadow-[123])\)/gu, (_, name) => homeDecl(name) ?? _)
                .replace(/var\(--maker-shadow-tint\)/gu, homeDecl("--maker-shadow-tint") ?? "var(--maker-shadow-tint)"),
        );
    // Only the ones the entry screens actually paint with: the site has marks the app has no counterpart for, and a
    // value copied across for a selector that does not exist here would be a line nobody could ever check by looking.
    const houseNames = [...maker.matchAll(/^\s*(--house-[\w-]+)\s*:/gmu)].map((m) => m[1]).filter((name) => entry.includes(`var(${name})`));
    for (const name of houseNames) {
        const expected = expandShadows(homeDecl(name) ?? "");
        const actual = decl(entryBlock, name);
        if (expected !== actual) {
            fail(`the entry screens' ${name}`, expected, actual ?? "(missing)");
        }
    }
    // The plate's washes fade toward paper in both, and it is the same paper.
    if (decl(entryBlock, "--scrim") !== homeDecl("--role-scrim")) {
        fail("the entry screens' --scrim is meant to be the site's --role-scrim", homeDecl("--role-scrim") ?? "(missing)", decl(entryBlock, "--scrim") ?? "(missing)");
    }
    // A frame's drop is the deepest of the three, and the site names it rather than writing it out.
    const frame = /html:not\(\[data-mode="dark"\]\) \.entry-frame \{([^}]*)\}/u.exec(entry)?.[1] ?? "";
    if (decl(frame, "box-shadow") !== expandShadows("var(--maker-shadow-3)")) {
        fail("the entry frame's drop shadow", expandShadows("var(--maker-shadow-3)"), decl(frame, "box-shadow") ?? "(missing)");
    }
}

if (failures.length > 0) {
    console.error(
        `maker palette has drifted from the app's light theme (${failures.length} ${failures.length === 1 ? "difference" : "differences"}).\n` +
            `  app   : _editor/ui/src/styles/{primitive,semantic}-colors.css\n` +
            `  maker  : _site/site/src/styles/maker.css\n` +
            `  entry : _shared/entry-css/entry.css (its light-scheme blocks)\n\n` +
            `${failures.join("\n\n")}\n\n` +
            `Copy the app's values across, or if the app moved on purpose, move the other two with it.`,
    );
    process.exit(1);
}
console.log(
    `maker palette matches the app's light theme: ${Object.values(RAMP).flat().length} ramp steps, ${ROLES.length} roles, the plate's scrim, and the entry screens' house materials.`,
);
