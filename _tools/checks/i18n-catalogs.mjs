#!/usr/bin/env node
// Checks that every message catalog carries the same keys in every language the app ships; usage: node
// _tools/checks/i18n-catalogs.mjs [--fix]. `en` is the source: it decides which keys exist, and the others must
// match it exactly.
//
// Why exactly, and not "at least": the app loads ONE language pack, not the pack plus English. That is what keeps a
// fifth language off the initial download, and the price of it is that a key missing from `pl.json` has nothing to
// fall back to at runtime — it renders as the key itself, in front of a reader. This check is the thing that makes
// that trade safe, so it gates as `code`.
//
// `--fix` writes the files back into shape: new keys arrive seeded with their English text (so the interface always
// reads as words, never as dotted paths, while a translation is still pending), keys that no longer exist in `en`
// are dropped, and everything is sorted. That is the command to run before a translation pass, and after one.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, trackedFiles, untrackedFiles } from "./lib/repo.mjs";

const LOCALES_FILE = "_editor/ui/src/i18n/locales.ts";
const BASE = "en";
const fix = process.argv.includes("--fix");

// Read the shipped languages from the module that declares them, so adding one there is the only edit needed.
const localesSource = readFileSync(join(root, LOCALES_FILE), "utf8");
const block = /export const LOCALES = \{([\s\S]*?)\n\} as const/.exec(localesSource);
if (block === null) {
    cannotMeasure(`${LOCALES_FILE}: no \`export const LOCALES = { … } as const\` block to read the languages from`);
}
const locales = [...block[1].matchAll(/^\s+(\w+): \{ endonym:/gm)].map((match) => match[1]);
if (!locales.includes(BASE)) {
    cannotMeasure(`${LOCALES_FILE}: declares ${locales.join(", ") || "nothing"}, which does not include the source language \`${BASE}\``);
}

const readText = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
};

// Dotted paths to every leaf, in document order. That is the shape worth comparing: two files can hold the same
// keys and still differ in nesting, and the difference is a real one — `t("a.b")` resolves by walking the tree.
const leaves = (tree, prefix = "") =>
    Object.entries(tree).flatMap(([name, value]) =>
        typeof value === "object" && value !== null ? leaves(value, `${prefix}${name}.`) : [`${prefix}${name}`],
    );

const at = (tree, path) => path.split(".").reduce((node, name) => (typeof node === "object" && node !== null ? node[name] : undefined), tree);

// Rebuilt from `en`'s shape rather than patched into the existing one — that is what drops orphans and sorts in the
// same pass. An existing translation is kept wherever `en` still has that key.
const reshape = (base, existing) =>
    Object.fromEntries(
        Object.keys(base)
            .sort()
            .map((name) => {
                const value = base[name];
                const had = typeof existing === "object" && existing !== null ? existing[name] : undefined;
                return typeof value === "object" && value !== null ? [name, reshape(value, had)] : [name, typeof had === "string" ? had : value];
            }),
    );

// Untracked too: a catalog added in the same change as the feature it translates is not committed yet, and it is
// exactly then that a missing language file is cheapest to hear about.
const catalogs = [...trackedFiles(), ...untrackedFiles()].filter((path) => path.endsWith(`/locales/${BASE}.json`));
if (catalogs.length === 0) {
    cannotMeasure(`no catalogs found: expected at least one **/locales/${BASE}.json`);
}

const missingFiles = [];
const missingKeys = [];
const orphanKeys = [];
const notSorted = [];
const vouched = [];
const written = [];

for (const catalog of catalogs) {
    const dir = dirname(join(root, catalog));
    const base = JSON.parse(readFileSync(join(dir, `${BASE}.json`), "utf8"));
    const expected = leaves(base).sort();
    let untranslated = 0;

    for (const locale of locales.filter((code) => code !== BASE)) {
        const path = join(dir, `${locale}.json`);
        const where = `${dirname(catalog)}/${locale}.json`;
        const source = readText(path);
        if (source === undefined && !fix) {
            missingFiles.push(where);
            continue;
        }

        let tree = source === undefined ? {} : JSON.parse(source);
        if (fix) {
            const next = `${JSON.stringify(reshape(base, tree), null, 4)}\n`;
            if (next !== source) {
                writeFileSync(path, next);
                written.push(where);
            }
            tree = JSON.parse(next);
        }

        const order = leaves(tree);
        const found = [...order].sort();
        for (const absent of expected.filter((leaf) => !found.includes(leaf))) {
            missingKeys.push(`${where}: ${absent}`);
        }
        for (const extra of found.filter((leaf) => !expected.includes(leaf))) {
            orphanKeys.push(`${where}: ${extra} (not in ${BASE}.json)`);
        }
        if (order.join(",") !== found.join(",")) {
            notSorted.push(where);
        }
        // An untranslated key is one whose text is still verbatim English. A handful of words are legitimately
        // identical across languages, so this is a progress reading, not a verdict — it never fails the check.
        untranslated += expected.filter((key) => at(tree, key) === at(base, key)).length;
    }

    const total = expected.length * (locales.length - 1);
    vouched.push(`${dirname(catalog)}: ${expected.length} keys × ${locales.length} languages, ${total - untranslated}/${total} translated`);
}

finish(
    [
        [`Language files missing (run with --fix to create them)`, missingFiles],
        [`Keys missing from a translation (run with --fix to seed them from ${BASE})`, missingKeys],
        [`Keys a translation has and ${BASE}.json does not (run with --fix to drop them)`, orphanKeys],
        [`Keys out of order (run with --fix to sort them)`, notSorted],
    ],
    [...written.map((path) => `wrote ${path}`), ...vouched],
);
