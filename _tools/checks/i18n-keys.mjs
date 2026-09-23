#!/usr/bin/env node
// Every key a `t()` call asks for exists, every message in a catalog is asked for, and every message compiles.
//
// This is the gate the compiler cannot be: vue-i18n's `t` takes any string whatever `DefineLocaleMessage` says, so a
// typo'd key is not a build error — it is a dotted path drawn in front of a reader. A message the compiler refuses
// (`@` is its link syntax, `|` its plural separator, `{` its placeholder) throws at the first render instead.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseCatalog } from "./lib/catalog.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, subjectFiles, subjectScope, trackedFiles, untrackedFiles } from "./lib/repo.mjs";

// Where a catalog mounts in the one message tree, which decides the keys its messages answer to. The editor's own
// catalog is at the root; everything else is namespaced away from it, so two packages cannot claim one key.
// An extension's `t` is bound to its own slice (`extensionT`), so its call sites name keys RELATIVE to that mount —
// which is why the table maps a directory to a prefix for resolution rather than to the mount itself.
const CATALOGS = [
    { dir: "_editor/ui/src/i18n/locales", prefix: "ui.", owns: ["_editor/ui/src/", "_editor/web/src/", "_editor/desktop-app/src/", "_editor/share-view/src/"] },
    { dir: "_editor/desktop-app/src/i18n/locales", prefix: "desktop.", owns: ["_editor/desktop-app/src/"] },
    { dir: "_editor/share-view/src/i18n/locales", prefix: "share.", owns: ["_editor/share-view/src/"] },
    { dir: "_editor/web/src/app/i18n/locales", prefix: "", owns: ["_editor/web/src/", "_editor/share-view/src/"] },
];

const leaves = (tree, prefix = "") =>
    Object.entries(tree).flatMap(([name, value]) => (typeof value === "object" && value !== null ? leaves(value, `${prefix}${name}.`) : [`${prefix}${name}`]));

// Catalogs that cannot be parsed; one stops the check, since every key it holds would otherwise read as missing.
const unreadable = [];
const read = (path) => {
    const { tree, problem } = parseCatalog(path, readFileSync(join(root, path), "utf8"));
    if (problem !== undefined) {
        unreadable.push(problem);
    }
    return tree ?? {};
};

const withKeys = (catalog, tree) => ({ ...catalog, tree, keys: new Set(leaves(tree).map((key) => `${catalog.prefix}${key}`)) });

// One entry per catalog: the keys it answers to, from where a call site stands.
const catalogs = [
    ...CATALOGS.map((catalog) => withKeys(catalog, read(`${catalog.dir}/en.json`))),
    // An extension's own catalog, reached from its own files only. Untracked too: a catalog added in the same change
    // as the words it holds is not committed yet, and that is exactly when a missing key is cheapest to hear about.
    ...[...trackedFiles(), ...untrackedFiles()]
        .filter((path) => /^_extensions\/[^/]+\/src\/locales\/en\.json$/.test(path))
        .map((path) => withKeys({ dir: dirname(path), prefix: "", owns: [`${path.split("/").slice(0, 2).join("/")}/`] }, read(path))),
];
if (unreadable.length > 0) {
    finish([["A message catalog that cannot be parsed, so none of its keys can be checked", unreadable]], []);
}

const reachableFrom = (path) => catalogs.filter((catalog) => catalog.owns.some((dir) => path.startsWith(dir)));

// A call this check can resolve: `t` with a literal first argument, and `<i18n-t keypath="…">`, which is the same ask
// spelled as markup. A key built from a variable cannot be resolved by anything static: the prefix before `${` is
// kept instead, so the messages under it are not then reported as dead.
const CALL = /(?<![.\w])t\(\s*(?:`([^`$]*)`|"([^"]*)"|'([^']*)')/g;
const KEYPATH = /keypath="([^"]*)"/g;
const DYNAMIC = /(?<![.\w])t\(\s*`([^`]*?)\$\{/g;

// Call sites not yet committed count too, for the reason the catalogs above do: the component that asks for a new
// key lands in the same change as the key, and without it every new key would read as dead until the commit.
const scope = subjectScope();
const untrackedSources = untrackedFiles().filter((path) => /\.(?:ts|vue)$/.test(path) && (scope === undefined || scope.has(path)));
// A test may register a fixture catalog of its own, so a key it asks for says nothing about the shipped ones.
const files = [...subjectFiles("*.ts", "*.vue"), ...untrackedSources].filter((path) => reachableFrom(path).length > 0 && !path.endsWith(".d.ts") && !path.endsWith(".test.ts"));
const missing = [];
const asked = new Set();
const askedPrefixes = [];
let dynamic = 0;
// A doc comment naming a key is prose about the layer, not an ask for a message: `t("title")` in the kit's own
// documentation must not be read as a call site. `:` before `//` keeps a url from being read as a comment.
const withoutComments = (source) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");

for (const path of files) {
    const source = withoutComments(readFileSync(join(root, path), "utf8"));
    for (const match of source.matchAll(DYNAMIC)) {
        dynamic += 1;
        askedPrefixes.push(match[1]);
    }
    const reach = reachableFrom(path);
    for (const match of [...source.matchAll(CALL), ...source.matchAll(KEYPATH)]) {
        const key = match[1] ?? match[2] ?? match[3];
        if (key === undefined || key === "") {
            continue;
        }
        asked.add(key);
        if (!reach.some((catalog) => catalog.keys.has(key))) {
            const line = source.slice(0, match.index).split("\n").length;
            missing.push(`${path}:${line}: ${key} — no catalog this file reads has it`);
        }
    }
}
const askedDynamically = (key) => askedPrefixes.some((prefix) => prefix !== "" && key.startsWith(prefix));

// Dead messages: a catalog carrying a key nobody asks for is a translation somebody will pay for twice. Only measured
// on a whole-tree run, since a scoped one has not read the call sites that would vouch for them.
const dead =
    subjectScope() === undefined
        ? catalogs.flatMap((catalog) => [...catalog.keys].filter((key) => !asked.has(key) && !askedDynamically(key)).map((key) => `${catalog.dir}/en.json: ${key.slice(catalog.prefix.length)}`))
        : [];

// The message compiler is vue-i18n's own, so what this accepts is exactly what a render accepts.
const uncompilable = [];
const compiler = (() => {
    try {
        return createRequire(join(root, "_editor/web/package.json"))("vue-i18n");
    } catch {
        return undefined;
    }
})();
if (compiler !== undefined) {
    for (const { dir, tree } of catalogs) {
        const i18n = compiler.createI18n({ legacy: false, locale: "en", fallbackLocale: "en", messages: { en: tree }, missingWarn: false, fallbackWarn: false });
        for (const key of leaves(tree)) {
            try {
                i18n.global.t(key);
            } catch (error) {
                uncompilable.push(`${dir}/en.json: ${key}: ${String(error.message).split("\n")[0]}`);
            }
        }
    }
}

if (catalogs.length < CATALOGS.length) {
    cannotMeasure(`expected a catalog at each of ${CATALOGS.map(({ dir }) => dir).join(", ")}`);
}

finish(
    [
        ["A `t()` key no catalog holds, which renders as its own dotted path in front of a reader", missing],
        ["A message nobody asks for: dead weight in every language it is translated into (delete it, or call it)", dead],
        ["A message vue-i18n cannot compile, which throws at the first render that needs it (`@`, `|` and `{` are its syntax)", uncompilable],
    ],
    [
        `i18n keys: ${asked.size} asked for across ${files.length} files, all of them in a catalog${dynamic === 0 ? "" : ` (${dynamic} built from a variable, which nothing static can check)`}`,
        compiler === undefined
            ? `i18n messages: not compiled (vue-i18n needs node_modules, and this ran before the install)`
            : `i18n messages: every message in ${catalogs.length} catalogs compiles`,
    ],
);
