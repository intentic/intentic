#!/usr/bin/env node
// A hover label is a word or two. `v-tooltip="t(`…`)"` whose English runs longer is a sentence in a box nobody reads:
// say it in two words, or pass a `Tip` (`_editor/ui/src/lib/tooltip.ts`), a compact card of a short headline, its
// figures as rows and one short closing line. A `Tip`'s own parts are held to their own lengths here too.
//
// What this reads: every `v-tooltip` in a translated surface's templates whose words it can resolve, a `t()` with a
// literal key looked up in the English catalog the file reads. A label built in `<script>` or handed down as a prop is
// not something a static read can resolve, so it is not judged. `.overflow` is exempt: its label is the anchor's own
// clipped text, shown whole, not a label anyone wrote. Best-effort before an install, like i18n-literals.mjs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCatalog } from "./lib/catalog.mjs";
import { finish } from "./lib/report.mjs";
import { ratchet } from "./lib/ratchet.mjs";
import { installedModule, packages, root, subjectFiles, trackedFiles, untrackedFiles } from "./lib/repo.mjs";

// Words each part may run to; a `{placeholder}` is one word, and a plural's longest form is the one judged.
const LIMITS = { label: 2, title: 3, rowLabel: 2, note: 5 };

// The same catalogs, mounted the same way, as i18n-keys.mjs reads them.
const CATALOGS = [
    { dir: "_editor/ui/src/i18n/locales", prefix: "ui.", owns: ["_editor/ui/src/", "_editor/web/src/", "_editor/desktop-app/src/", "_editor/share-view/src/"] },
    { dir: "_editor/desktop-app/src/i18n/locales", prefix: "desktop.", owns: ["_editor/desktop-app/src/"] },
    { dir: "_editor/share-view/src/i18n/locales", prefix: "share.", owns: ["_editor/share-view/src/"] },
    { dir: "_editor/web/src/app/i18n/locales", prefix: "", owns: ["_editor/web/src/", "_editor/share-view/src/"] },
];

// A catalog is JSON: a branch is an object, a message is a string.
const leaves = (tree, prefix = "") =>
    Object.entries(tree).flatMap(([name, value]) => (value instanceof Object ? leaves(value, `${prefix}${name}.`) : [[`${prefix}${name}`, value]]));

const messagesOf = (dir, prefix) => {
    const path = `${dir}/en.json`;
    const { tree } = parseCatalog(path, readFileSync(join(root, path), "utf8"));
    return new Map(leaves(tree ?? {}).map(([key, value]) => [`${prefix}${key}`, String(value)]));
};

const catalogs = [
    ...CATALOGS.map((catalog) => ({ ...catalog, messages: messagesOf(catalog.dir, catalog.prefix) })),
    ...[...trackedFiles(), ...untrackedFiles()]
        .filter((path) => /^_extensions\/[^/]+\/src\/locales\/en\.json$/.test(path))
        .map((path) => ({ owns: [`${path.split("/").slice(0, 2).join("/")}/`], messages: messagesOf(dirname(path), "") })),
];

const englishFor = (path, key) => {
    for (const catalog of catalogs) {
        if (catalog.owns.some((dir) => path.startsWith(dir)) && catalog.messages.has(key)) {
            return catalog.messages.get(key);
        }
    }
    return undefined;
};

// vue-i18n's `{'…'}` literal is text, a `{name}` placeholder one word; a plural is judged by its longest form.
const wordsIn = (message) =>
    Math.max(
        ...message
            .replaceAll(/\{\s*'([^']*)'\s*\}/g, "$1")
            .split("|")
            .map((form) => form.replaceAll(/\{[^}]*\}/g, "X").trim().split(/\s+/).filter(Boolean).length),
    );

const TRANSLATED = ["_editor/web/src/", "_editor/ui/src/", "_editor/desktop-app/src/", "_editor/share-view/src/", "_extensions/"];
const NOT_FOR_READERS = new Set(["_editor/web/src/features/settings/DesignKit.vue"]);
const files = subjectFiles("**/*.vue").filter((path) => TRANSLATED.some((dir) => path.startsWith(dir)) && !NOT_FOR_READERS.has(path));

const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const parsers = (() => {
    if (files.length === 0 || vueHost === undefined) {
        return undefined;
    }
    const sfc = installedModule(vueHost.dir, "vue/compiler-sfc");
    const ts = installedModule(vueHost.dir, "typescript");
    return sfc === undefined || ts === undefined ? undefined : { sfc, ts };
})();

const DIRECTIVE = 7;
const isLookup = (ts, node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^\$?t$/.test(node.expression.text);
const keyOf = (ts, call) => {
    const first = call.arguments[0];
    return first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
};
const propName = (ts, property) => (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined);

// Which part of a tip a property's value lands in. A row's label is held to a label's length only inside `rows`; its
// value is a figure or a name and is not judged, nor is anything else an object literal carries.
const TIP_PARTS = { title: "title", note: "note", rows: "rows" };
const innerPart = (name, part) => (name === "label" && part === "rows" ? "rowLabel" : Object.hasOwn(TIP_PARTS, name ?? "") ? TIP_PARTS[name] : undefined);

// The lookups one tooltip expression draws, each with the part of the box it lands in. A lookup's own arguments are
// placeholders' values, never labels, so they are not descended into.
const partsIn = (ts, expression) => {
    const file = ts.createSourceFile("tooltip.ts", `(${expression})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found = [];
    const visit = (node, part) => {
        if (isLookup(ts, node)) {
            const key = keyOf(ts, node);
            if (key !== undefined) {
                found.push({ key, part });
            }
            return;
        }
        if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties.filter((each) => ts.isPropertyAssignment(each))) {
                const inner = innerPart(propName(ts, property), part);
                if (inner !== undefined) {
                    visit(property.initializer, inner);
                }
            }
            return;
        }
        ts.forEachChild(node, (child) => visit(child, part));
    };
    ts.forEachChild(file, (child) => visit(child, "label"));
    return found.filter(({ part }) => part !== "rows");
};

const long = [];
const perFile = new Map();

// A `v-tooltip` whose words this reads: not `.overflow`, whose label is the anchor's own text.
const isJudged = (prop) =>
    prop.type === DIRECTIVE && prop.name === "tooltip" && prop.exp !== undefined && !prop.modifiers.some((modifier) => (modifier.content ?? modifier) === "overflow");

const judge = (ts, path, prop) => {
    for (const { key, part } of partsIn(ts, prop.exp.content)) {
        const english = englishFor(path, key);
        if (english === undefined || wordsIn(english) <= LIMITS[part]) {
            continue;
        }
        perFile.set(path, (perFile.get(path) ?? 0) + 1);
        long.push({ path, line: prop.loc.start.line, text: `${part === "label" ? "" : `${part}: `}${key} = ${JSON.stringify(english)} (${wordsIn(english)} words, ${LIMITS[part]} at most)` });
    }
};
if (parsers !== undefined) {
    const { sfc, ts } = parsers;
    for (const path of files) {
        const source = readFileSync(join(root, path), "utf8");
        const ast = sfc.parse(source, { filename: path }).descriptor.template?.ast;
        if (ast === undefined || ast === null) {
            continue;
        }
        const visit = (node) => {
            for (const prop of (node.props ?? []).filter(isJudged)) {
                judge(ts, path, prop);
            }
            for (const child of [...(node.children ?? []), ...(node.branches ?? [])]) {
                visit(child);
            }
        };
        visit(ast);
    }
}

// Labels that predate this rule are the standing backlog (baselines/tooltip-words.json); a file may only shed them.
const { grown } = ratchet("tooltip-words", "tooltip-words", perFile);
const grownPaths = new Set(grown.map(({ key }) => key));

finish(
    [
        [
            "A hover label longer than a word or two, more than the file's baseline allows (say it in two words, or pass a `Tip` card from @intentic/ui: a short title, figures as rows, one short note)",
            long.filter(({ path }) => grownPaths.has(path)).map(({ path, line, text }) => `${path}:${line}: ${text}`),
        ],
    ],
    [
        parsers === undefined
            ? `tooltip words: ${files.length} templates not read (vue/compiler-sfc needs node_modules, and this ran before the install)`
            : `tooltip words: every resolvable hover label in ${files.length} templates is a word or two, or a compact card`,
    ],
);
