#!/usr/bin/env node
// No English typed into a template the app ships. A label written as `<Button label="Save">` cannot be translated,
// cannot be found by anyone counting what is left to translate, and reaches a Polish reader in English — so the words
// live in a catalog and the template asks for them: `:label="t(\`ui.action.save\`)"`.
// What this does not judge: the sandbox daemon, the CLIs, the site (Astro has its own routing-based i18n), and the
// standalone extension repositories, none of which render through vue-i18n.
// Best-effort before an install, like vue-templates.mjs: vouches for less when vue/compiler-sfc cannot be resolved.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { packages, root, subjectFiles } from "./lib/repo.mjs";
import { visibleLiterals } from "./lib/visible-text.mjs";

// Every surface that mounts vue-i18n. A .vue file outside them (the seed template an extension author copies) has no
// catalog to put words in.
const TRANSLATED = ["_editor/web/src/", "_editor/ui/src/", "_editor/desktop-app/src/", "_editor/share-view/src/", "_extensions/"];

// Screens that are not shipped to a reader, so their words are not a translator's problem.
const NOT_FOR_READERS = new Set([
    "_editor/web/src/features/settings/DesignKit.vue", // the dev-only design kit, mounted behind import.meta.env.DEV
]);

const files = subjectFiles("**/*.vue").filter((path) => TRANSLATED.some((dir) => path.startsWith(dir)) && !NOT_FOR_READERS.has(path));

// The SFC parser for the markup and the TypeScript one for what a bound attribute holds — a quote scanner reads
// `busy ? \`Stop ${n}\` : "Start"` as one literal and lands its rewrite in the middle of another.
const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const parsers = (() => {
    if (files.length === 0 || vueHost === undefined) {
        return undefined;
    }
    try {
        const load = createRequire(join(vueHost.dir, "package.json"));
        return { sfc: load("vue/compiler-sfc"), ts: load("typescript") };
    } catch {
        return undefined;
    }
})();

const untranslatable = [];
if (parsers !== undefined) {
    for (const path of files) {
        const source = readFileSync(join(root, path), "utf8");
        for (const finding of visibleLiterals(source, path, parsers)) {
            const text = finding.kind === "run" ? finding.parts.map((part) => part.text ?? "{…}").join("") : finding.text;
            untranslatable.push(`${path}:${finding.line}: ${finding.kind === "text" || finding.kind === "run" ? "" : `${finding.name}=`}${JSON.stringify(text.trim())}`);
        }
    }
}

finish(
    [["English typed into a template instead of a catalog, so no translation can reach it (move it to the package's locales/en.json and call `t`)", untranslatable]],
    [
        parsers === undefined
            ? `i18n literals: ${files.length} templates not read (vue/compiler-sfc needs node_modules, and this ran before the install)`
            : `i18n literals: all ${files.length} translated-surface templates take their words from a catalog`,
    ],
);
