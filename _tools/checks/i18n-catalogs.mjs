#!/usr/bin/env node
// A translation holds a subset of `en`'s keys (the rest fall back to `en`), with `en`'s placeholders and plural-ness; `--fix` drops keys `en` lacks.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCatalog } from "./lib/catalog.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, trackedFiles, untrackedFiles } from "./lib/repo.mjs";

const LOCALES_FILE = "_editor/ui/src/i18n/locales.ts";
const BASE = "en";
const fix = process.argv.includes("--fix");

const localesSource = readFileSync(join(root, LOCALES_FILE), "utf8");
const block = /export const LOCALES = \{([\s\S]*?)\n\} as const/.exec(localesSource);
if (block === null) {
    cannotMeasure(`${LOCALES_FILE}: no \`export const LOCALES = { … } as const\` block to read the languages from`);
}
const locales = [...block[1].matchAll(/^\s+(\w+): \{ endonym:/gm)].map((match) => match[1]);
if (!locales.includes(BASE)) {
    cannotMeasure(`${LOCALES_FILE}: declares ${locales.join(", ") || "nothing"}, which does not include the source language \`${BASE}\``);
}
const translations = locales.filter((code) => code !== BASE);

// Undefined only for a file that is not there: `--fix` writes an empty catalog over whatever this could not read.
const readText = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
};

const isTree = (value) => typeof value === "object" && value !== null;

const leaves = (tree, prefix = "") =>
    Object.entries(tree).flatMap(([name, value]) => (isTree(value) ? leaves(value, `${prefix}${name}.`) : [[`${prefix}${name}`, value]]));

const prune = (tree, base) =>
    Object.fromEntries(
        Object.entries(tree).flatMap(([name, value]) => {
            if (!isTree(value)) {
                return typeof base[name] === "string" ? [[name, value]] : [];
            }
            const inner = isTree(base[name]) ? prune(value, base[name]) : {};
            return Object.keys(inner).length === 0 ? [] : [[name, inner]];
        }),
    );

// `{'…'}` is vue-i18n's literal syntax, so what it quotes is neither a placeholder nor a plural separator.
const unquoted = (message) => message.replaceAll(/\{\s*'[^']*'\s*\}/g, "");
const placeholders = (message) =>
    [...new Set([...unquoted(message).matchAll(/\{\s*([^}\s]+)\s*\}/g)].map((match) => `{${match[1]}}`))].sort().join(" ");
const isPlural = (message) => unquoted(message).includes("|");

const catalogs = [...trackedFiles(), ...untrackedFiles()].filter((path) => path.endsWith(`/locales/${BASE}.json`));
if (catalogs.length === 0) {
    cannotMeasure(`no catalogs found: expected at least one **/locales/${BASE}.json`);
}

const unreadable = [];
const missingFiles = [];
const orphanKeys = [];
const wrongPlaceholders = [];
const wrongPlurals = [];
const vouched = [];
const written = [];

for (const catalog of catalogs) {
    const dir = dirname(catalog);
    const { tree: base, problem } = parseCatalog(catalog, readFileSync(join(root, catalog), "utf8"));
    if (problem !== undefined) {
        unreadable.push(problem);
        continue;
    }
    const english = new Map(leaves(base));
    const untranslated = [];

    for (const locale of translations) {
        const where = `${dir}/${locale}.json`;
        const source = readText(join(root, where));
        if (source === undefined && !fix) {
            missingFiles.push(where);
            continue;
        }

        const parsed = source === undefined ? { tree: {} } : parseCatalog(where, source);
        // Never rewritten by --fix: reshaping what could not be read would drop every translation in it.
        if (parsed.problem !== undefined) {
            unreadable.push(parsed.problem);
            continue;
        }
        let { tree } = parsed;
        if (fix) {
            tree = prune(tree, base);
            const next = `${JSON.stringify(tree, null, 4)}\n`;
            if (next !== source) {
                writeFileSync(join(root, where), next);
                written.push(where);
            }
        }

        let held = 0;
        for (const [key, message] of leaves(tree)) {
            const original = english.get(key);
            if (original === undefined) {
                orphanKeys.push(`${where}: ${key}`);
                continue;
            }
            held += 1;
            if (placeholders(message) !== placeholders(original)) {
                wrongPlaceholders.push(`${where}: ${key} has [${placeholders(message)}], ${BASE} has [${placeholders(original)}]`);
            }
            if (isPlural(message) !== isPlural(original)) {
                wrongPlurals.push(`${where}: ${key}`);
            }
        }
        untranslated.push(`${locale} ${english.size - held}`);
    }

    vouched.push(`${dir}: ${english.size} keys, untranslated (rendered in ${BASE}): ${untranslated.join(", ")}`);
}

finish(
    [
        [`Catalogs that cannot be parsed (resolve them by hand; --fix leaves them alone)`, unreadable],
        [`Language files missing: every language's loader imports one (run with --fix to create it empty)`, missingFiles],
        [`Keys a translation has and ${BASE}.json does not (run with --fix to drop them)`, orphanKeys],
        [`Placeholders that differ from ${BASE}'s: a call passes ${BASE}'s names, so any other renders empty`, wrongPlaceholders],
        [`Plural in one language and not the other: \`|\` separates the forms a count picks between`, wrongPlurals],
    ],
    [...written.map((path) => `wrote ${path}`), ...vouched],
);
