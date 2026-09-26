// WHAT A CHANGE ADDED TO THE LINT, read against the file as it was: the per-edit hook (lint-edit.mjs) asks it of one file
// against HEAD, and the check after a land (land-tiers.mjs) asks it of every file the land changed against the commit it
// left. A rule set with a backlog (.oxlintrc.plugins.json) is enforced this way, on what a change adds and never on what
// it found.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";

/** The extensions `pnpm lint` reads. */
export const LINTABLE = new Set([`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.vue`, `.astro`]);

/** The enforced rule set, and the one with a backlog that is held only to what a change adds (it repeats the root's ignores). */
export const ROOT_CONFIG = `.oxlintrc.json`;
export const PLUGINS_CONFIG = `.oxlintrc.plugins.json`;

// The rules only the plugins config adds; the root rules are `pnpm lint`'s to report whole.
export const PLUGIN_RULE = /^(anti-slop|complexity)\(/u;

export const OXLINT_TIMEOUT_MS = 60_000;

/** The oxlint binary for `checkout`: its own, else the one beside this script (a bare copy may not mirror node_modules). */
export const oxlintIn = (checkout) =>
    [checkout, repoRoot(import.meta.url)].map((dir) => join(dir, `node_modules/.bin/oxlint`)).find((bin) => existsSync(bin));

// A message that states a measured score against a limit ("Function 'f' has Cognitive Complexity of 38. Maximum allowed
// is 20." then a breakdown of every line that scored) is about the function it names: `head` is the rule's metric and that
// name, `score` the measured value.
const SCORED = /^(?<head>.+?) of (?<score>\d+)\. Maximum allowed is \d+\./u;

// HOW A FINDING NOW IS MATCHED TO ONE BEFORE. A scored finding is matched by rule, metric and symbol (the file is the
// caller's grouping), and is new only when that symbol had no such finding or its score went up: its breakdown lists every
// offending line, so matching it by message would make any resize of the function, a reduction included, read as new.
// Any other finding is matched by rule and message with every number blanked, never position: an insertion above shifts
// every offset below it.
const identityOf = (d) => {
    const scored = SCORED.exec(d.message);
    return scored === null ? `${d.code} ${d.message.replaceAll(/\d+/gu, `#`)}` : `${d.code} ${scored.groups.head}`;
};

// The value measured: a scored message's score, else the first number in it ("nested too deeply (5)"); undefined for a
// rule that counts nothing.
const measured = (d) => {
    const found = SCORED.exec(d.message)?.groups.score ?? /\d+/u.exec(d.message)?.[0];
    return found === undefined ? undefined : Number(found);
};

// Each diagnostic's `pick`, grouped by its identity.
const grouped = (list, pick) => {
    const groups = new Map();
    for (const d of list) {
        groups.set(identityOf(d), [...(groups.get(identityOf(d)) ?? []), pick(d)]);
    }
    return groups;
};

// Of one identity's diagnostics, those the baseline's values do not account for. Equal values pair off first, so a new
// finding is never blamed on an untouched one of the same identity; the rest pair smallest to smallest.
const unaccounted = (list, baselineValues) => {
    const held = [...baselineValues];
    const unmatched = [];
    for (const d of list) {
        const at = held.indexOf(measured(d));
        if (at === -1) {
            unmatched.push(d);
        } else {
            held.splice(at, 1);
        }
    }
    unmatched.sort((left, right) => (measured(left) ?? 0) - (measured(right) ?? 0));
    held.sort((left, right) => (left ?? 0) - (right ?? 0));
    return unmatched.filter((d, index) => {
        const value = measured(d);
        const was = held[index];
        const grew = value !== undefined && was !== undefined && value > was;
        return index >= held.length || grew;
    });
};

// A plugin finding that names its symbol ("Rename symbol "STATE_SHAPES" …") is about that name, and such a rule flags
// every reference to it: one more use of a name the file already had is not a new name. Those count once per file.
const namesItsSymbol = (d) => PLUGIN_RULE.test(d.code) && !SCORED.test(d.message) && /"[^"]+"/u.test(d.message);

/**
 * What one file's `current` diagnostics have that its `baseline` did not: an identity the baseline lacked, or one whose
 * measured value grew (identityOf says what an identity is).
 */
export const introduced = (current, baseline) => {
    const before = grouped(baseline, measured);
    return [...grouped(current, (d) => d)].flatMap(([key, list]) => {
        if (namesItsSymbol(list[0]) && before.has(key)) {
            return [];
        }
        return unaccounted(list, before.get(key) ?? []);
    });
};

/** oxlint's JSON report for `files` under `config`, or undefined when it answered with anything else. */
export const report = (oxlint, checkout, config, ...files) => {
    const read = (stdout) => {
        const parsed = JSON.parse(stdout);
        return { diagnostics: parsed.diagnostics ?? [], files: parsed.number_of_files ?? 0 };
    };
    try {
        // Not --silent: it empties the JSON report too.
        return read(
            execFileSync(oxlint, [`-c`, join(checkout, config), `-f`, `json`, `--no-error-on-unmatched-pattern`, ...files], {
                cwd: checkout,
                encoding: `utf8`,
                stdio: [`ignore`, `pipe`, `ignore`],
                timeout: OXLINT_TIMEOUT_MS,
                maxBuffer: 64 * 1024 * 1024,
            }),
        );
    } catch (error) {
        // A non-zero exit with findings still prints the report.
        try {
            return read(error.stdout ?? `{}`);
        } catch {
            // allow(silent-catch): output that is not oxlint's JSON is the "did not answer" every caller reports
            return undefined;
        }
    }
};

/** Diagnostics for `content` read as the file at `rel`, from a scratch copy outside the tree that keeps its basename. */
export const diagnosticsOf = (oxlint, checkout, config, rel, content) => {
    // Same basename, so filename-shaped overrides (`**/*.test.ts`) still apply; outside the tree, so no full lint reads it.
    const scratch = mkdtempSync(join(tmpdir(), `oxlint-baseline-`));
    try {
        const copy = join(scratch, basename(rel));
        writeFileSync(copy, content);
        return report(oxlint, checkout, config, copy)?.diagnostics;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

const gitShow = (checkout, rev, rel) => {
    try {
        return execFileSync(`git`, [`show`, `${rev}:${rel}`], { cwd: checkout, encoding: `buffer`, stdio: [`ignore`, `pipe`, `ignore`], maxBuffer: 64 * 1024 * 1024 });
    } catch {
        // allow(silent-catch): absent at `rev`, so every finding in the file is the change's
        return undefined;
    }
};

// Plugin-rule diagnostics per file, keyed by path relative to `under`, from ONE oxlint run over `paths`: a land can touch
// hundreds of files, and a process each would cost minutes of the check after it. Undefined when oxlint did not answer.
const pluginFindingsOf = (oxlint, checkout, paths, under) => {
    const found = report(oxlint, checkout, PLUGINS_CONFIG, ...paths);
    if (found === undefined) {
        return undefined;
    }
    const byFile = new Map();
    for (const d of found.diagnostics.filter((each) => PLUGIN_RULE.test(each.code))) {
        const rel = relative(under, resolve(checkout, d.filename));
        byFile.set(rel, [...(byFile.get(rel) ?? []), d]);
    }
    return byFile;
};

/**
 * Plugin-rule findings the tree's `files` (repo-relative, present) have that they did not have at `base`, as units
 * `lint <file>: <rule> <message>`. Files the config ignores are skipped, as `pnpm lint` skips them; oxlint failing to
 * answer is one unit saying so, since "nothing added" is not what it said.
 */
export const addedPluginFindings = (checkout, base, files) => {
    const oxlint = oxlintIn(checkout);
    if (files.length === 0 || oxlint === undefined || !existsSync(join(checkout, PLUGINS_CONFIG))) {
        return [];
    }
    const now = pluginFindingsOf(oxlint, checkout, files, checkout);
    if (now === undefined) {
        return [`lint-plugins could not run on the ${files.length} file(s) the change touched`];
    }
    if (now.size === 0) {
        return [];
    }
    // The same files as `base` holds them, at the same relative paths so path-shaped overrides still apply, outside the tree.
    const scratch = mkdtempSync(join(tmpdir(), `oxlint-base-`));
    try {
        const held = [...now.keys()].flatMap((rel) => {
            const content = gitShow(checkout, base, rel);
            if (content === undefined) {
                return [];
            }
            mkdirSync(dirname(join(scratch, rel)), { recursive: true });
            writeFileSync(join(scratch, rel), content);
            return [join(scratch, rel)];
        });
        const before = held.length === 0 ? new Map() : pluginFindingsOf(oxlint, checkout, held, scratch);
        if (before === undefined) {
            return [`lint-plugins could not run on the touched files as ${base.slice(0, 9)} holds them`];
        }
        return [...now].flatMap(([rel, diagnostics]) =>
            introduced(diagnostics, before.get(rel) ?? []).map((d) => `lint ${rel}: ${d.code} ${d.message.replaceAll(`\n`, ` `)}`),
        );
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};
