#!/usr/bin/env node
// No new dead code, as knip reads it (knip.json): an export nothing imports, a file nothing reaches, a dependency
// nothing uses or one used without being declared. Each costs a reader the time to learn it is dead. An export kept on
// purpose for something knip cannot see says so with knip's own `/** @public */` tag on its declaration.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { packages, root } from "./lib/repo.mjs";

const KNIP = join(root, "node_modules/knip/bin/knip.js");

if (!existsSync(KNIP)) {
    finish([], [`dead-code: not measured (knip lives in node_modules, and this ran before the install); the verify jobs measure it`]);
    process.exit(0);
}

// knip loads prisma.config.ts, which refuses to load without a database URL; nothing connects to it.
const ran = spawnSync(process.execPath, [KNIP, `--reporter`, `json`, `--no-progress`, `--no-exit-code`], {
    cwd: root,
    encoding: `utf8`,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? `postgresql://knip@localhost/knip` },
});
// A config knip could not load (a plugin's `ERROR:` line) drops that workspace's entries and would read as findings.
const failed = ran.status !== 0 || ran.error !== undefined || /^ERROR:/mu.test(ran.stderr ?? ``);
if (failed) {
    cannotMeasure(`dead-code: knip did not finish cleanly, so nothing was measured:\n${(ran.stderr || ran.error?.message || `exit ${ran.status}`).trim()}`);
}
let report;
try {
    report = JSON.parse(ran.stdout);
} catch {
    cannotMeasure(`dead-code: knip's JSON report did not parse; its output shape moved and this check needs updating`);
}
if (!Array.isArray(report?.issues)) {
    cannotMeasure(`dead-code: knip's JSON report has no \`issues\` list; its output shape moved and this check needs updating`);
}

// The manifest a dependency finding belongs to: the nearest workspace package holding the file, else the root's.
const manifests = packages.map(({ dir }) => relative(root, dir)).toSorted((a, b) => b.length - a.length);
const manifestOf = (file) => {
    const owner = manifests.find((dir) => file === `${dir}/package.json` || file.startsWith(`${dir}/`));
    return owner === undefined ? `package.json` : `${owner}/package.json`;
};

const code = new Map();
const deps = new Map();
const add = (into, key, line) => into.set(key, [...(into.get(key) ?? []), line]);
const DEPENDENCY_KINDS = [
    [`dependencies`, `unused dependency`],
    [`devDependencies`, `unused devDependency`],
    [`optionalPeerDependencies`, `unused optional peer dependency`],
    [`unlisted`, `unlisted dependency`],
    [`unresolved`, `unresolved import`],
];
for (const issue of report.issues) {
    const { file } = issue;
    if (issue.files?.length > 0) {
        add(code, file, `${file}  unused file`);
    }
    for (const item of issue.exports ?? []) {
        add(code, file, `${file}:${item.line}  unused export \`${item.name}\``);
    }
    for (const item of issue.types ?? []) {
        add(code, file, `${file}:${item.line}  unused type \`${item.name}\``);
    }
    for (const [kind, label] of DEPENDENCY_KINDS) {
        for (const item of issue[kind] ?? []) {
            add(deps, manifestOf(file), `${file}:${item.line ?? 1}  ${label} \`${item.name}\``);
        }
    }
}

const counts = (found) => new Map([...found].map(([key, lines]) => [key, lines.length]));
const codeRun = ratchet(`dead-code`, `dead-code`, counts(code));
// A package's dependency findings move with any file in it, not only with its manifest.
const depsRun = ratchet(`dead-code`, `dead-code-deps`, counts(deps), {
    touchedBy: (key, path) => dirname(key) === `.` || path.startsWith(`${dirname(key)}/`),
});
if (ADOPTING) {
    process.exit(0);
}

const problems = (found, grown) =>
    grown.flatMap(({ key, count, allowed }) => [...found.get(key), `${key}: ${count} finding(s), the baseline allows ${allowed}`]);
const total = (found) => [...found.values()].reduce((sum, lines) => sum + lines.length, 0);

finish(
    [
        [`new dead code: delete it, use it, or tag an export kept for something knip cannot see with /** @public */`, problems(code, codeRun.grown)],
        [`a new unused, undeclared or unresolved dependency: declare it in the package that imports it, or drop it`, problems(deps, depsRun.grown)],
    ],
    [
        `dead-code: no new dead code (${total(code)} unused exports, types and files standing in ${code.size} files, held by baselines/dead-code.json)`,
        `dead-code: no new dependency finding (${total(deps)} standing in ${deps.size} manifests, held by baselines/dead-code-deps.json)`,
    ],
);
