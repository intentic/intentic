#!/usr/bin/env node
// No English typed into a template the app ships. A label written as `<Button label="Save">` cannot be translated,
// cannot be found by anyone counting what is left to translate, and reaches a Polish reader in English — so the words
// live in a catalog and the template asks for them: `:label="t(\`ui.action.save\`)"`.
// What this does not judge: the sandbox daemon, the CLIs, the site (Astro has its own routing-based i18n), and the
// standalone extension repositories, none of which render through vue-i18n.
// Best-effort before an install, like vue-templates.mjs: vouches for less when vue/compiler-sfc cannot be resolved.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { ratchet } from "./lib/ratchet.mjs";
import { installedModule, packages, root, subjectFiles } from "./lib/repo.mjs";
import { visibleLiterals } from "./lib/visible-text.mjs";

// Every surface that mounts vue-i18n. A .vue file outside them (the seed template an extension author copies) has no
// catalog to put words in.
const TRANSLATED = ["_editor/web/src/", "_editor/ui/src/", "_editor/desktop-app/src/", "_editor/share-view/src/", "_extensions/"];

// Screens that are not shipped to a reader, so their words are not a translator's problem.
const NOT_FOR_READERS = new Set([
    "_editor/web/src/features/settings/DesignKit.vue", // the dev-only design kit, mounted behind import.meta.env.DEV
]);

const files = subjectFiles("**/*.vue").filter((path) => TRANSLATED.some((dir) => path.startsWith(dir)) && !NOT_FOR_READERS.has(path));

// The modules whose words reach a reader by argument (SPOKEN_ARGUMENT, below).
const codeFiles = subjectFiles("**/*.ts").filter(
    (path) => TRANSLATED.some((dir) => path.startsWith(dir)) && !/\.(test|d)\.ts$/.test(path) && !path.includes("/testing/") && !path.endsWith("/testing.ts"),
);

// The SFC parser for the markup and the TypeScript one for what a bound attribute holds — a quote scanner reads
// `busy ? \`Stop ${n}\` : "Start"` as one literal and lands its rewrite in the middle of another.
const vueHost = packages.find(({ pkg }) => pkg.dependencies?.vue !== undefined || pkg.devDependencies?.vue !== undefined);
const parsers = (() => {
    if ((files.length === 0 && codeFiles.length === 0) || vueHost === undefined) {
        return undefined;
    }
    const sfc = installedModule(vueHost.dir, "vue/compiler-sfc");
    const ts = installedModule(vueHost.dir, "typescript");
    return sfc === undefined || ts === undefined ? undefined : { sfc, ts };
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

// THE SAME RULE FOR WORDS CODE SAYS. A template is not the only way English reaches the screen: a notice, a receipt and
// the line a failed write reports are handed to a helper as an argument, from a plain `.ts` module. The helpers and
// which argument each one draws; `warn` is the notification one, never `console.warn`, and `run` is the store's
// `run(task, wrote)`, whose second argument is the failure's own sentence.
const SPOKEN_ARGUMENT = new Map([
    ["say", 0],
    ["sayDeleted", 0],
    ["warn", 0],
    ["noticeOf", 0],
    ["noticeFrom", 1],
    ["run", 1],
]);
// A string or template whose own text has a word in it; a key, a path or a bare interpolation has none.
const spokenLiteral = (ts, node) =>
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
    /[A-Za-z]{2}/.test(ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ") : node.text);
const calleeName = (ts, callee) => (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined);
const spokenInCode = new Map();
const codeFindings = [];
if (parsers !== undefined) {
    const { ts } = parsers;
    for (const path of codeFiles) {
        const source = ts.createSourceFile(path, readFileSync(join(root, path), "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node) => {
            if (ts.isCallExpression(node)) {
                const name = calleeName(ts, node.expression);
                const at = name === undefined ? undefined : SPOKEN_ARGUMENT.get(name);
                const console = ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "console";
                const argument = at === undefined ? undefined : node.arguments[at];
                if (argument !== undefined && !console && spokenLiteral(ts, argument)) {
                    const line = source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1;
                    spokenInCode.set(path, (spokenInCode.get(path) ?? 0) + 1);
                    codeFindings.push({ path, line, text: argument.getText(source) });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
}
// Code that predates this rule is the standing backlog (baselines/i18n-code-literals.json); a file may only shed it.
const { grown } = ratchet("i18n-literals", "i18n-code-literals", spokenInCode);
const grownPaths = new Set(grown.map(({ key }) => key));
const spokenUntranslatable = codeFindings.filter(({ path }) => grownPaths.has(path)).map(({ path, line, text }) => `${path}:${line}: ${text.slice(0, 100)}`);

finish(
    [
        ["English typed into a template instead of a catalog, so no translation can reach it (move it to the package's locales/en.json and call `t`)", untranslatable],
        ["English handed to a notice, a receipt or a failure line from code, more than the file's baseline allows (move it to the catalog and pass `t(…)`)", spokenUntranslatable],
    ],
    [
        parsers === undefined
            ? `i18n literals: ${files.length} templates not read (vue/compiler-sfc needs node_modules, and this ran before the install)`
            : `i18n literals: all ${files.length} translated-surface templates take their words from a catalog, and ${codeFiles.length} modules add no English to what they say`,
    ],
);
