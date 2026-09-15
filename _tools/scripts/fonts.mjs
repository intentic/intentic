#!/usr/bin/env node
// Downloads every webfont this repo serves, and writes the @font-face rules that declare them.
//
//   node _tools/scripts/fonts.mjs
//
// Both the app and the marketing site used to pull their faces from Google's CDN at runtime. For the site that was
// merely a third-party request; for the APP it was a defect, because intentic runs agents in sandboxes and a
// workspace that is offline, air-gapped or behind a content blocker fell back to system fonts with nothing to say
// so. Everything is self-hosted now, and this is what regenerates it.
//
// Output is committed. Re-run it when a family, a weight range or a subset changes here.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

// Google serves woff2 only to a browser it believes supports it; with node's own agent it answers with ttf.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

// Latin and latin-ext only. Every other subset Google offers — cyrillic, greek, vietnamese — is weight nobody on
// these pages reads, and the ranges below keep the browser from downloading a file for characters that never appear.
const SUBSETS = ["latin", "latin-ext"];

/**
 * A family, as a request rather than a file: `weights` is what goes to Google, and a variable family answers with
 * ONE file covering the range however many weights are asked for. Asking for a narrower range than the face has
 * costs nothing and silently clamps anything outside it, so these ask for the whole axis where there is one.
 */
const FAMILIES = {
    "public-sans": { family: "Public+Sans", weights: "100..900", css: "Public Sans" },
    spectral: { family: "Spectral", weights: "600", css: "Spectral" },
    "baloo-2": { family: "Baloo+2", weights: "400..800", css: "Baloo 2" },
    "jetbrains-mono": { family: "JetBrains+Mono", weights: "100..800", css: "JetBrains Mono" },
};

// Which package serves which faces, and where its stylesheet goes.
const TARGETS = [
    {
        label: "app",
        fonts: "_editor/web/public/fonts",
        css: "_editor/web/src/styles/faces.css",
        url: "/fonts",
        families: ["public-sans", "spectral", "baloo-2", "jetbrains-mono"],
    },
    {
        label: "site",
        fonts: "_site/site/public/fonts",
        css: "_site/site/src/styles/faces.css",
        url: "/fonts",
        // The site sets no code in a webfont — its code blocks take the system mono stack.
        families: ["public-sans", "spectral", "baloo-2"],
    },
    {
        label: "app",
        fonts: "_editor/desktop-app/public/fonts",
        css: "_editor/desktop-app/src/styles/faces.css",
        url: "/fonts",
        // The launcher wears the entry skin but draws no carved headline, so it needs no display serif.
        families: ["public-sans", "baloo-2", "jetbrains-mono"],
    },
];

const field = (body, name) => new RegExp(`${name}:\\s*([^;]+);`, "u").exec(body)?.[1]?.trim();

const blocksIn = (css) =>
    [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/gu)]
        .map(([, subset, body]) => ({
            subset: subset ?? "",
            weight: field(body ?? "", "font-weight"),
            url: /src:\s*url\(([^)]+)\)/u.exec(body ?? "")?.[1]?.trim(),
            range: field(body ?? "", "unicode-range"),
        }))
        .filter((block) => block.weight !== undefined && block.url !== undefined && block.range !== undefined);

/** A variable family answers with one URL for every weight asked for; a static one answers with several. */
const byFile = (group) => {
    const grouped = new Map();
    for (const block of group) {
        grouped.set(block.url, [...(grouped.get(block.url) ?? []), block]);
    }
    return [...grouped].map(([url, weights]) => {
        // A variable family asked for a RANGE comes back as one block whose `font-weight` is already "100 900";
        // parsing that as a number gives NaN, so a single block keeps its own value and only several are spanned.
        const numbers = weights.map((block) => Number(block.weight)).filter((weight) => Number.isFinite(weight));
        const span = numbers.length > 1 ? `${Math.min(...numbers)} ${Math.max(...numbers)}` : (weights[0].weight ?? "400");
        return { url, range: weights[0].range, span };
    });
};

const download = async (id, spec, subset, { url, span, range }) => {
    const body = await fetch(url, { headers: { "User-Agent": UA } });
    if (!body.ok) {
        throw new Error(`${id} ${span}: ${body.status} for ${url}`);
    }
    return {
        file: `${id}-${span.replace(/\s+/gu, "-")}-${subset}.woff2`,
        css: spec.css,
        weight: span,
        range,
        bytes: Buffer.from(await body.arrayBuffer()),
    };
};

/** Fetches one family's subsets, returning what to write. Memoised, since both targets want most of the same faces. */
const cache = new Map();
const faceFor = async (id) => {
    const held = cache.get(id);
    if (held !== undefined) {
        return held;
    }
    const spec = FAMILIES[id];
    const href = `https://fonts.googleapis.com/css2?family=${spec.family}:wght@${spec.weights}&display=swap`;
    const sheet = await fetch(href, { headers: { "User-Agent": UA } });
    if (!sheet.ok) {
        throw new Error(`${id}: Google answered ${sheet.status} for ${href}`);
    }
    const blocks = blocksIn(await sheet.text());
    const faces = [];
    for (const subset of SUBSETS) {
        const group = blocks.filter((block) => block.subset === subset);
        if (group.length === 0) {
            throw new Error(`${id}: no ${subset} subset in ${href}`);
        }
        for (const cut of byFile(group)) {
            faces.push(await download(id, spec, subset, cut));
        }
    }
    cache.set(id, faces);
    return faces;
};

for (const target of TARGETS) {
    await mkdir(join(root, target.fonts), { recursive: true });
    const rules = [
        `/* GENERATED by _tools/scripts/fonts.mjs — do not edit. Self-hosted so nothing here needs a network to set`,
        `   type: a workspace with no egress renders in the face it was designed in, not in the system fallback. */`,
    ];
    let written = 0;
    let bytes = 0;
    for (const id of target.families) {
        for (const face of await faceFor(id)) {
            await writeFile(join(root, target.fonts, face.file), face.bytes);
            written += 1;
            bytes += face.bytes.length;
            rules.push(
                `@font-face {`,
                `    font-family: "${face.css}";`,
                `    font-style: normal;`,
                `    font-weight: ${face.weight};`,
                `    font-display: swap;`,
                `    src: url("${target.url}/${face.file}") format("woff2");`,
                `    unicode-range: ${face.range};`,
                `}`,
            );
        }
    }
    await writeFile(join(root, target.css), `${rules.join("\n")}\n`);
    console.log(`${target.label.padEnd(5)} ${written} files, ${(bytes / 1024).toFixed(0)} KB -> ${target.fonts}`);
}
