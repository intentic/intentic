#!/usr/bin/env node
// `node _tools/oxlint/lint-edit.mjs <file>`: autofixes the file silently, then reports only the diagnostics its HEAD
// version did not have, under the root rules and the plugin tier (.oxlintrc.plugins.json, added.mjs), less complexity,
// which the code-shape check reports. Exit 2 with the report, else 0, including whenever it cannot measure (no binary, no git).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { keptAnswer } from "../checks/lib/kept.mjs";
import { repoRoot } from "../constants/src/node.mjs";
import { diagnosticsOf, introduced, LINTABLE, oxlintIn, oxlintOut, PLUGINS_CONFIG, report as lintReport, reportFlags, ROOT_CONFIG } from "./added.mjs";

// Rules a half-written file trips honestly, which `pnpm lint` still reads in CI's push check.
const DEFERRED = new Set([`eslint(no-unused-vars)`]);

// The complexity rule's findings, which the code-shape check (_tools/checks/code-shape.mjs) reports for the same edit.
const heldElsewhere = (d) => d.code?.startsWith(`complexity(`) === true;

// One fix can create what another rule repairs, so fixing repeats until a pass changes nothing, at most this often.
const FIX_PASSES = 4;

// The checkout holding `file`: its git top-level when that is a copy of this repository, else the one holding this script.
const checkoutOf = (file) => {
    try {
        const top = execFileSync(`git`, [`rev-parse`, `--show-toplevel`], {
            cwd: dirname(file),
            encoding: `utf8`,
            stdio: [`ignore`, `pipe`, `ignore`],
        }).trim();
        if (existsSync(join(top, ROOT_CONFIG))) {
            return top;
        }
    } catch {
        // Not in a git checkout: the script's own is the only candidate.
    }
    return realpathSync(repoRoot(import.meta.url));
};

// The rules judged: the root set plus the plugin tier, whose backlog is why only what the edit adds is reported. A file
// the root config ignores is not judged at all, as `pnpm lint` does not judge it; the plugin tier repeats the root's
// ignores (a test in _tools/scripts/verify/measure-change.test.mjs holds them equal).
const configOf = (checkout) => (existsSync(join(checkout, PLUGINS_CONFIG)) ? PLUGINS_CONFIG : ROOT_CONFIG);
const lint = (oxlint, checkout, file, judged) => (judged === false ? [] : lintReport(oxlint, checkout, configOf(checkout), file)?.diagnostics);

// A JSON report's files linted and diagnostics; undefined for output that is not one (a crash, a timeout).
const parsedReport = (stdout) => {
    try {
        const parsed = JSON.parse(stdout);
        return Number.isInteger(parsed.number_of_files) ? { files: parsed.number_of_files, diagnostics: parsed.diagnostics ?? [] } : undefined;
    } catch {
        // allow(silent-catch): output that is not oxlint's JSON leaves the question to the plugin tier's own report
        return undefined;
    }
};

// Fixes under `config` until a pass changes nothing, answering whether it judged the file at all (`judged`, false for one
// it ignores, undefined when the last pass did not say) and, once a pass changed nothing, that pass's report as the
// file's diagnostics (undefined when no pass settled or the last said nothing).
const fixUntilSettled = (oxlint, checkout, file, config) => {
    let previous = readFileSync(file, `utf8`);
    let judged;
    for (let pass = 0; pass < FIX_PASSES; pass++) {
        let stdout;
        try {
            stdout = oxlintOut(oxlint, checkout, [`--fix`, ...reportFlags(checkout, config), file]);
        } catch (error) {
            // Non-zero means problems remain, which is the normal state between passes; the report is still printed.
            stdout = String(error?.stdout ?? ``);
        }
        const report = parsedReport(stdout);
        judged = report === undefined ? undefined : report.files > 0;
        const now = readFileSync(file, `utf8`);
        if (now === previous) {
            return { judged, diagnostics: report?.diagnostics };
        }
        previous = now;
    }
    return { judged, diagnostics: undefined };
};

// The file fixed, and its diagnostics under the judged config when the fixing already read them. The passes run the
// plugin tier itself: none of the rules it adds has a fix, so its fixes are the root's, and the pass that changed nothing
// reported the file as it stands, with the flags the report takes. Fixing under the root config and then reporting under
// the plugin tier were two oxlint runs an edit; this is one. A plugin tier that cannot run at all (a JS plugin that no
// longer loads) says nothing, and the root config fixes the file as before.
const fixed = (oxlint, checkout, file) => {
    const config = configOf(checkout);
    const settled = fixUntilSettled(oxlint, checkout, file, config);
    return settled.judged === undefined && config !== ROOT_CONFIG ? { judged: fixUntilSettled(oxlint, checkout, file, ROOT_CONFIG).judged } : settled;
};

const gitIn = (checkout, ...args) => execFileSync(`git`, args, { cwd: checkout, encoding: `buffer`, stdio: [`ignore`, `pipe`, `ignore`] });

// The path HEAD held `rel` under when the index records the file as moved (a `git mv`), so a moved module is judged
// against its own history: compared with nothing, every finding it carried over would read as this edit's.
const renamedFrom = (checkout, rel) => {
    let staged;
    try {
        staged = gitIn(checkout, `diff`, `--cached`, `--name-status`, `--find-renames`, `--diff-filter=R`, `HEAD`).toString(`utf8`);
    } catch {
        // allow(silent-catch): no HEAD or no index to ask is no rename on record, and the file is judged as new
        return undefined;
    }
    for (const line of staged.split(`\n`)) {
        const [status, from, to] = line.split(`\t`);
        if (status?.startsWith(`R`) && to === rel) {
            return from;
        }
    }
    return undefined;
};

// What the HEAD version's diagnostics depend on, besides its bytes: the basename it is linted under (filename-shaped
// overrides), both configs, the anti-slop plugin's source and the installed oxlint, @oxlint/plugins and complexity
// plugin. Every edit of a file until the next commit is measured against the same HEAD blob, and linting it is a whole
// plugin-tier oxlint run, so the answer is kept (../checks/lib/kept.mjs) rather than measured again each edit.
const filesUnder = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));

const baselineInputs = (checkout, config, rel, head) => {
    const plugin = join(checkout, `_tools/oxlint/anti-slop`);
    return [
        config,
        basename(rel),
        head,
        ...[ROOT_CONFIG, PLUGINS_CONFIG].flatMap((name) => [name, existsSync(join(checkout, name)) ? readFileSync(join(checkout, name)) : ``]),
        ...(existsSync(plugin) ? filesUnder(plugin).toSorted() : []).flatMap((path) => [relative(plugin, path), readFileSync(path)]),
        ...[`oxlint`, `@oxlint/plugins`, `oxlint-plugin-complexity`].map((name) => {
            const path = join(checkout, `node_modules`, name);
            return existsSync(path) ? realpathSync(path) : `absent ${name}`;
        }),
    ];
};

// Diagnostics of the file as HEAD holds it, under its own path or the one it was moved from: none when HEAD lacks it
// (all of it is this edit's), undefined when git cannot answer.
const baselineOf = (oxlint, checkout, rel) => {
    let head;
    try {
        head = gitIn(checkout, `show`, `HEAD:${renamedFrom(checkout, rel) ?? rel}`);
    } catch {
        try {
            gitIn(checkout, `cat-file`, `-e`, `HEAD`);
            return [];
        } catch {
            return undefined;
        }
    }
    const config = configOf(checkout);
    return keptAnswer(`lint-edit-head`, baselineInputs(checkout, config, rel, head), () => diagnosticsOf(oxlint, checkout, config, rel, head)) ?? [];
};

// `:line:column` for a byte offset into `text`; oxlint's JSON reports spans as offsets.
const position = (text, offset) => {
    if (typeof offset !== `number`) {
        return ``;
    }
    const upto = text.slice(0, offset);
    return `:${upto.split(`\n`).length}:${upto.length - upto.lastIndexOf(`\n`)}`;
};

const report = (rel, text, fresh) => {
    const lines = fresh.map((d) => {
        const help = d.help ? `\n     ${d.help.replaceAll(`\n`, ` `)}` : ``;
        return `  ${rel}${position(text, d.labels?.[0]?.span?.offset)}  ${d.code ?? `unused-directive`}\n     ${d.message.replaceAll(`\n`, ` `)}${help}`;
    });
    return (
        `oxlint: ${fresh.length} new problem${fresh.length === 1 ? `` : `s`} in ${rel}, introduced by this edit; everything autofixable is already fixed.\n\n` +
        `${lines.join(`\n`)}\n\n` +
        `Each rule's reason is in .oxlintrc.json or .oxlintrc.plugins.json. If one is wrong here, say so rather than adding a disable comment ` +
        `(unicorn/no-abusive-eslint-disable is on).\n`
    );
};

const main = () => {
    const [arg] = process.argv.slice(2);
    if (arg === undefined || arg === `` || !LINTABLE.has(extname(arg))) {
        return 0;
    }
    const file = realpathSync(arg);
    const checkout = checkoutOf(file);
    const rel = relative(checkout, file);
    const oxlint = oxlintIn(checkout);
    if (rel.startsWith(`..`) || oxlint === undefined) {
        return 0;
    }

    const settled = fixed(oxlint, checkout, file);
    const current = (settled.diagnostics ?? lint(oxlint, checkout, file, settled.judged) ?? []).filter((d) => !DEFERRED.has(d.code) && !heldElsewhere(d));
    if (current.length === 0) {
        return 0;
    }
    const baseline = baselineOf(oxlint, checkout, rel)?.filter((d) => !heldElsewhere(d));
    if (baseline === undefined) {
        return 0;
    }
    const fresh = introduced(current, baseline);
    if (fresh.length === 0) {
        return 0;
    }
    process.stderr.write(report(rel, readFileSync(file, `utf8`), fresh));
    return 2;
};

try {
    process.exit(main());
} catch {
    process.exit(0);
}
