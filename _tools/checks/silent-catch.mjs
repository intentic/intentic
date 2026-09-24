#!/usr/bin/env node
// No new handler that throws the error away: `.catch(() => undefined)`, an empty `catch {}`, a `catch` that only returns
// a literal. Each turns every failure (EACCES, a timeout, a bug's TypeError) into the same quiet "absent", so the one it
// was written for and the ones nobody foresaw read alike. Narrow instead (`undefinedIfMissing` from @intentic/base/errors,
// a status check) or log what failed. A discard that is right says why: `// silent-catch: <reason>` in it or above it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/;
// A suite asserts on failures on purpose, and generated or vendored output is fixed at its source.
const EXEMPT = /(\.(test|spec|bench)\.[cm]?[jt]sx?$|(^|\/)(e2e|dist|node_modules|vendor)\/|\/testing\.ts$|\.d\.[cm]?ts$)/;
const GENERATED = [`_site/site/public/`, `_editor/web/public/ext-shims/`, `_sandbox/sandbox/operator-templates/`];
// This file spells every shape it looks for.
const SELF = `_tools/checks/silent-catch.mjs`;

// Whitespace and comments only: what an empty body may hold.
const NOTHING = String.raw`\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*`;
// A value that stands in for the result without saying what went wrong.
const LITERAL = String.raw`(?:undefined|null|void 0|false|true|0|\[\]|\{\}|""|''|\`\`)`;
// A handler that cannot read the error: no parameter, or one named as a throwaway.
const BLIND = String.raw`(?:\(\s*(?:_\w*(?:\s*:\s*\w+)?)?\s*\)|_\w*)`;
const SHAPES = [
    { why: `.catch discards the error`, pattern: new RegExp(String.raw`\.catch\(\s*(?:async\s*)?${BLIND}\s*=>\s*(?:${LITERAL}|\{${NOTHING}\})\s*\)`, `g`) },
    { why: `empty catch block`, pattern: new RegExp(String.raw`\bcatch\s*(?:\(\s*\w+(?:\s*:\s*\w+)?\s*\))?\s*\{${NOTHING}\}`, `g`) },
    {
        why: `catch returns a literal and drops the error`,
        pattern: new RegExp(String.raw`\bcatch\s*(?:\(\s*\w+(?:\s*:\s*\w+)?\s*\))?\s*\{${NOTHING}return(?:\s+${LITERAL})?\s*;?${NOTHING}\}`, `g`),
    },
];

// A reason inside the handler, on its line, or on the one above it; an empty reason is no reason.
const PRAGMA = /silent-catch:\s*\S/;

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

const files = subjectFiles().filter((path) => path !== SELF && CODE.test(path) && !EXEMPT.test(path) && !GENERATED.some((prefix) => path.startsWith(prefix)));
const found = new Map();
for (const path of files) {
    const text = readFileSync(join(root, path), `utf8`);
    if (!text.includes(`catch`)) {
        continue;
    }
    const lines = text.split(`\n`);
    const findings = [];
    for (const { why, pattern } of SHAPES) {
        for (const match of text.matchAll(pattern)) {
            const line = lineOf(text, match.index);
            if (PRAGMA.test(match[0]) || PRAGMA.test(lines[line - 1]) || (line > 1 && PRAGMA.test(lines[line - 2]))) {
                continue;
            }
            findings.push({ line, why });
        }
    }
    if (findings.length > 0) {
        found.set(
            path,
            findings.toSorted((a, b) => a.line - b.line),
        );
    }
}

const { grown } = ratchet(`silent-catch`, `silent-catch`, new Map([...found].map(([path, findings]) => [path, findings.length])));
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key, count, allowed }) => [
    ...found.get(key).map(({ line, why }) => `${key}:${line}  ${why}`),
    `${key}: ${count} silent catch(es), the baseline allows ${allowed}`,
]);

finish(
    [[`a new silent catch: narrow it (undefinedIfMissing, a status check), log it, or say why with // silent-catch: <reason>`, problems]],
    [`${files.length} source files read: no new silent catch (${[...found.values()].reduce((sum, list) => sum + list.length, 0)} standing, held by the baseline)`],
);
