#!/usr/bin/env node
// No file, function or complexity score grows past what the tree already holds. A file new to the tree may run to 600
// lines; one already longer may not grow past its baseline. A function over 100 lines, or over the cyclomatic or
// cognitive cap `.oxlintrc.plugins.json` sets, may not get worse than its baseline. Complexity is oxlint-plugin-complexity's
// score under that config's own options, so the number here is the one the linter prints; names and spans are nav's
// parser's (_tools/nav/lib/parse.mjs). A rename, a reorder, a move, a `git mv` or a split carries its allowance with it
// (lib/shape.mjs's `judge`), and `--tighten` writes it under the new name. Without node_modules (CI preflight, the
// nightly tidy job) only file length is measured, and the vouched line says so.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, vueScript } from "../nav/lib/files.mjs";
import { OXLINT_TIMEOUT_MS, oxlintIn, PLUGINS_CONFIG } from "../oxlint/added.mjs";
import { ADOPTING, allowanceOf, ratchet } from "./lib/ratchet.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, subjectScope } from "./lib/repo.mjs";
import { CAPS, complexityOf, findingOf, functionAt, ignoredBy, judge, keyOf, lineCount, measuredSource, parseJsonc, partsOf, qualified, touchedBy } from "./lib/shape.mjs";

const NAME = `code-shape`;
const RULE = `complexity/complexity`;

const config = parseJsonc(readFileSync(join(root, PLUGINS_CONFIG), `utf8`));
const ignored = ignoredBy(config.ignorePatterns ?? []);
const fileSet = new Set(listFiles(root).source.filter((path) => measuredSource(path, ignored) && existsSync(join(root, path))));
const scope = subjectScope();
const subjects = [...fileSet].filter((path) => scope === undefined || scope.has(path));

const baselineFile = join(root, `_tools/checks/baselines/${NAME}.json`);
const baseline = new Map(Object.entries(existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, `utf8`)) : {}).map(([key, value]) => [key, allowanceOf(value)]));

const texts = new Map();
const textOf = (path) => {
    if (!texts.has(path)) {
        texts.set(path, readFileSync(join(root, path), `utf8`));
    }
    return texts.get(path);
};

// The config the complexity meter runs under: the plugins config's own rule options, plugin and overrides, with every
// other rule left out (a third of the time an edit waits), written outside the tree with the plugin named by path.
const complexityConfig = () => {
    const specifier = (config.jsPlugins ?? []).map((entry) => entry.specifier ?? entry).find((each) => each.includes(`complexity`));
    const options = config.rules?.[RULE];
    if (specifier === undefined || options === undefined || options === `off`) {
        return undefined;
    }
    const plugin = specifier.startsWith(`.`) ? join(root, specifier) : join(root, `node_modules`, specifier);
    const overrides = (config.overrides ?? []).filter((each) => each.rules?.[RULE] !== undefined).map((each) => ({ files: each.files, rules: { [RULE]: each.rules[RULE] } }));
    return existsSync(plugin) ? { plugins: [], categories: { correctness: `off` }, jsPlugins: [plugin], rules: { [RULE]: options }, overrides } : undefined;
};

const oxlint = oxlintIn(root);
const meter = oxlint === undefined ? undefined : complexityConfig();
// nav's parser needs typescript, which only an install has; it loads once oxlint is already running.
let typescript;
try {
    typescript = import.meta.resolve(`typescript`);
} catch {
    // allow(silent-catch): no typescript is no install, which measures file length alone and says so
    typescript = undefined;
}
let parse;
const loadParser = async () => {
    parse ??= typescript === undefined ? undefined : await import(`../nav/lib/parse.mjs`);
};
const metrics = new Set([`file`, ...(typescript === undefined ? [] : [`lines`]), ...(meter === undefined ? [] : [`cyclomatic`, `cognitive`])]);

// oxlint's complexity findings for `paths`, written to a file rather than a pipe so it runs while this process parses.
const startMeter = (paths) => {
    if (meter === undefined || paths.length === 0) {
        return Promise.resolve({ scores: [], broken: [] });
    }
    const scratch = mkdtempSync(join(tmpdir(), `code-shape-`));
    writeFileSync(join(scratch, `oxlintrc.json`), JSON.stringify(meter));
    const out = openSync(join(scratch, `out.json`), `w`);
    return new Promise((resolve) => {
        const child = spawn(oxlint, [`-c`, join(scratch, `oxlintrc.json`), `-f`, `json`, `--no-error-on-unmatched-pattern`, ...paths], {
            cwd: root,
            stdio: [`ignore`, out, `ignore`],
            timeout: OXLINT_TIMEOUT_MS,
        });
        child.on(`error`, (error) => resolve({ error }));
        child.on(`close`, () => resolve({}));
    }).then(({ error }) => {
        closeSync(out);
        const output = readFileSync(join(scratch, `out.json`), `utf8`);
        rmSync(scratch, { recursive: true, force: true });
        try {
            const { diagnostics } = JSON.parse(output);
            // A finding with no rule is a file oxlint could not parse, whose functions this run cannot honestly score.
            return { scores: diagnostics.filter((d) => d.code?.startsWith(`complexity(`)), broken: diagnostics.filter((d) => d.code === undefined).map((d) => d.filename) };
        } catch {
            return cannotMeasure(`code-shape: oxlint did not answer in JSON (${error?.message ?? output.slice(0, 200)}), so no complexity was measured`);
        }
    });
};

const functions = new Map();
const functionsIn = (path) => {
    if (!functions.has(path)) {
        const text = textOf(path);
        const offset = path.endsWith(`.vue`) ? vueScript(text).lineOffset : 0;
        const found = parse.functionsOf(parse.parseFile(path, text)).map((fn) => ({ ...fn, startLine: fn.startLine + offset, endLine: fn.endLine + offset }));
        functions.set(path, qualified(found));
    }
    return functions.get(path);
};

const ANONYMOUS = new Set([`<arrow>`, `<anonymous>`, ``]);

// The complexity finding `d` as a measurement, named by nav's parser where it parsed the file.
const scored = (d) => {
    const { metric, score, name } = complexityOf(d.message) ?? {};
    const span = d.labels?.[0]?.span;
    if (metric === undefined || span === undefined) {
        return undefined;
    }
    const bytes = Buffer.from(textOf(d.filename));
    const endLine = span.line + (bytes.subarray(span.offset, span.offset + span.length).toString(`utf8`).match(/\n/gu)?.length ?? 0);
    const fn = parse === undefined ? undefined : functionAt(functionsIn(d.filename), span.line, endLine);
    return { path: d.filename, symbol: fn?.name ?? (ANONYMOUS.has(name) ? `<anonymous>` : name), metric, value: score, line: span.line };
};

// Files oxlint could not parse: measured for length alone, their functions standing as the baseline holds them.
const unparsed = new Set();

// Every measurement over its cap in `paths`.
const measure = async (paths) => {
    const pending = startMeter(paths);
    await loadParser();
    const items = [];
    for (const path of paths) {
        const lines = lineCount(textOf(path));
        if (lines > CAPS.file) {
            items.push({ path, metric: `file`, value: lines, line: 1 });
        }
        if (parse !== undefined && lines > CAPS.lines) {
            for (const fn of functionsIn(path).filter((each) => each.lines > CAPS.lines)) {
                items.push({ path, symbol: fn.name, metric: `lines`, value: fn.lines, line: fn.startLine });
            }
        }
    }
    const { scores, broken } = await pending;
    for (const path of broken) {
        unparsed.add(path);
    }
    return [...items, ...scores.map(scored).filter((item) => item !== undefined)].filter((item) => item.metric === `file` || !unparsed.has(item.path));
};

const linesOf = (path) => (fileSet.has(path) ? lineCount(textOf(path)) : undefined);
const measured = new Set(subjects);
const measuredPath = (path, metric) => !fileSet.has(path) || (measured.has(path) && (metric === `file` || !unparsed.has(path)));
let items = await measure(subjects);
let judged = judge({ items, baseline, measuredPath, metrics, linesOf });

// A scoped run has not read the files a function new here may have come from: it reads those holding an entry of the
// same name and metric big enough to lend, then judges again, so a move reads as one here as it does on the whole tree.
if (scope !== undefined) {
    const borrowers = [...judged.keyed].filter(([key, item]) => item.metric !== `file` && !baseline.has(key) && !judged.lent.has(key)).map(([, item]) => item);
    const sources = [...baseline]
        .map(([key, allowance]) => ({ allowance, ...partsOf(key) }))
        .filter((entry) => !measured.has(entry.path) && fileSet.has(entry.path))
        .filter((entry) => borrowers.some((item) => item.metric === entry.metric && item.symbol === entry.symbol && item.value <= entry.allowance))
        .map((entry) => entry.path);
    const extra = [...new Set(sources)];
    if (extra.length > 0) {
        items = [...items, ...(await measure(extra))];
        for (const path of extra) {
            measured.add(path);
        }
        judged = judge({ items, baseline, measuredPath, metrics, linesOf });
    }
}

const { keyed, lent } = judged;
const found = new Map([...keyed].filter(([, item]) => scope === undefined || scope.has(item.path)).map(([key, item]) => [key, item.value]));
// What this run could not measure stands as the baseline holds it, so it is neither growth nor beaten, and no tighten drops it.
if (scope === undefined) {
    for (const [key, allowance] of baseline) {
        const { path, metric } = partsOf(key);
        if (!found.has(key) && (!metrics.has(metric) || !measuredPath(path, metric))) {
            found.set(key, allowance);
        }
    }
}

const { grown } = ratchet(NAME, NAME, found, { touchedBy, lent });
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.map(({ key, allowed }) => findingOf(keyed.get(key), allowed)).toSorted();
const standing = [...found.keys()].filter((key) => baseline.has(key) || lent.has(key)).length;
const what =
    metrics.size === 4
        ? `no file over ${CAPS.file} lines, function over ${CAPS.lines} lines or complexity over the plugin's caps past its baseline`
        : `file length only, since ${typescript === undefined ? `node_modules is absent` : `oxlint or its complexity plugin is absent`}: no file over ${CAPS.file} lines past its baseline`;

finish(
    [
        [
            `code that grew past its shape cap or its baseline (${keyOf({ path: `<path>`, symbol: `<name>`, metric: `<metric>` })}): shrink or split what grew. A rename, a move, a git mv or a split carries its allowance (_tools/checks/README.md)`,
            problems,
        ],
    ],
    [`${subjects.length} source files read: ${what} (${standing} standing, held by baselines/${NAME}.json)`],
);
