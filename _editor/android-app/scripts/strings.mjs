#!/usr/bin/env node
// Writes the app's strings from the web editor's catalogs, so a sentence is translated once: each key strings.keys
// lists, in every language that has it, into res/values{,-de,-es,-fr,-pl}/strings.xml. The keys are the web's own:
// the app's catalog at the root, and the UI kit's (`_editor/ui`) under `ui.`, where vue-i18n mounts it. A language without a key leaves it
// out, and Android falls back to English as the web does. With `--check` it writes nothing and fails when a file is stale.
//
//   node _editor/android-app/scripts/strings.mjs [--check]
//
// Placeholders: `{name}` becomes `%<n>$s`, numbered in the order the names first appear in the ENGLISH message, so
// `getString(id, a, b)` passes the same values in the same order whichever language reorders its words. A plural's
// count is one of them too (`{count}`): pass it as the quantity and again as its argument.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "../../../_tools/constants/src/node.mjs";
import { banner, emit } from "./lib/generated.mjs";
import { parse, positions, render, resourceName } from "./lib/messages.mjs";
import { LOCALES, quantities } from "./lib/plurals.mjs";

const root = repoRoot(import.meta.url);
const app = resolve(import.meta.dirname, `..`);
// Each catalog directory and the namespace its keys sit under, as the web registers them (`registerCatalog`).
const CATALOGS = [
    { dir: `_editor/web/src/app/i18n/locales`, mount: `` },
    { dir: `_editor/ui/src/i18n/locales`, mount: `ui` },
];

// A catalog is nested objects down to messages; flattened here, where it is read, into dotted keys.
const flatten = (tree, prefix = ``, into = new Map()) => {
    for (const [key, value] of Object.entries(tree)) {
        const path = prefix === `` ? key : `${prefix}.${key}`;
        if (value instanceof Object) {
            flatten(value, path, into);
        } else {
            into.set(path, String(value));
        }
    }
    return into;
};

const keys = readFileSync(join(app, `strings.keys`), `utf8`)
    .split(`\n`)
    .map((line) => line.trim())
    .filter((line) => line !== `` && !line.startsWith(`#`));
const catalogOf = (locale) => {
    const into = new Map();
    for (const { dir, mount } of CATALOGS) {
        flatten(JSON.parse(readFileSync(join(root, dir, `${locale}.json`), `utf8`)), mount, into);
    }
    return into;
};
const catalogs = new Map(LOCALES.map((locale) => [locale, catalogOf(locale)]));

// Every key's placeholder positions come from English, which every translation must agree with.
const english = new Map(
    keys.map((key) => {
        const message = catalogs.get(`en`).get(key);
        if (message === undefined) {
            throw new Error(`strings.keys names ${key}, which no English catalog has`);
        }
        return [key, positions(parse(message))];
    }),
);

const names = new Map();
for (const key of keys) {
    const name = resourceName(key);
    if (names.has(name)) {
        throw new Error(`${key} and ${names.get(name)} both make the resource name ${name}`);
    }
    names.set(name, key);
}

const entry = (locale, key, message) => {
    const forms = parse(message);
    const order = english.get(key);
    const name = resourceName(key);
    if (forms.length === 1) {
        const formatted = order.size > 0;
        const plain = !formatted && message.includes(`%`) ? ` formatted="false"` : ``;
        return [`    <string name="${name}"${plain}>${render(forms[0], order, formatted)}</string>`];
    }
    // A plural is always read with getQuantityString(id, n, args…), so its text is always formatted.
    const items = quantities(locale, forms.length, key).map(([quantity, index]) => `        <item quantity="${quantity}">${render(forms[index], order, true)}</item>`);
    return [`    <plurals name="${name}">`, ...items, `    </plurals>`];
};

const file = (locale) =>
    [
        `<?xml version="1.0" encoding="utf-8"?>`,
        banner(`strings.mjs`, CATALOGS.map(({ dir }) => `${dir}/${locale}.json`).join(` and `)),
        `<resources>`,
        ...keys.flatMap((key) => {
            const message = catalogs.get(locale).get(key);
            return message === undefined ? [] : entry(locale, key, message);
        }),
        `</resources>`,
        ``,
    ].join(`\n`);

const res = join(app, `app/src/main/res`);
process.exitCode = emit(new Map(LOCALES.map((locale) => [join(res, locale === `en` ? `values` : `values-${locale}`, `strings.xml`), file(locale)])), {
    check: process.argv.includes(`--check`),
    command: `node _editor/android-app/scripts/strings.mjs`,
    root,
});
