#!/usr/bin/env node
// `node _tools/oxlint/lint-edit.mjs <file>`: autofixes the file silently, then reports only the diagnostics its HEAD
// version did not have. Exit 2 with the report, else 0, including whenever it cannot measure (no binary, no git).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";

// The extensions `pnpm lint` reads.
const LINTABLE = new Set([`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.vue`, `.astro`]);

// Rules a half-written file trips honestly; `pnpm lint` still reads them in the check after the land and at the push.
const DEFERRED = new Set([`eslint(no-unused-vars)`]);

const OXLINT_TIMEOUT_MS = 60_000;

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
        if (existsSync(join(top, `.oxlintrc.json`))) {
            return top;
        }
    } catch {
        // Not in a git checkout: the script's own is the only candidate.
    }
    return realpathSync(repoRoot(import.meta.url));
};

// A linked worktree mirrors node_modules by symlink, but a bare copy may not, so the script's checkout is the fallback.
const oxlintIn = (checkout) =>
    [checkout, repoRoot(import.meta.url)].map((dir) => join(dir, `node_modules/.bin/oxlint`)).find((bin) => existsSync(bin));

// Rule and message with every number blanked, never position: an insertion above shifts every offset below it.
const shape = (d) => `${d.code} ${d.message.replaceAll(/\d+/gu, `#`)}`;

// The first number in a message is the value measured ("nested too deeply (5)"); undefined for a rule that counts nothing.
const measured = (d) => {
    const found = /\d+/u.exec(d.message);
    return found === null ? undefined : Number(found[0]);
};

// What `current` has that `baseline` did not: a shape HEAD lacked, or one whose measured value grew.
const introduced = (current, baseline) => {
    const before = new Map();
    for (const d of baseline) {
        before.set(shape(d), [...(before.get(shape(d)) ?? []), measured(d)]);
    }
    const after = new Map();
    for (const d of current) {
        after.set(shape(d), [...(after.get(shape(d)) ?? []), d]);
    }

    const fresh = [];
    for (const [key, list] of after) {
        // Equal values pair off first, so a new finding is never blamed on an untouched one of the same shape.
        const held = [...(before.get(key) ?? [])];
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
        for (const [index, d] of unmatched.entries()) {
            const value = measured(d);
            const was = held[index];
            if (index >= held.length || (value !== undefined && was !== undefined && value > was)) {
                fresh.push(d);
            }
        }
    }
    return fresh;
};

// Diagnostics for `file`, or undefined when oxlint answered with anything but its JSON report.
const lint = (oxlint, checkout, file) => {
    const read = (stdout) => JSON.parse(stdout).diagnostics ?? [];
    try {
        // Not --silent: it empties the JSON report too.
        return read(
            execFileSync(oxlint, [`-c`, join(checkout, `.oxlintrc.json`), `-f`, `json`, `--no-error-on-unmatched-pattern`, file], {
                cwd: checkout,
                encoding: `utf8`,
                stdio: [`ignore`, `pipe`, `ignore`],
                timeout: OXLINT_TIMEOUT_MS,
            }),
        );
    } catch (error) {
        // A non-zero exit with findings still prints the report.
        try {
            return read(error.stdout ?? `{}`);
        } catch {
            return undefined;
        }
    }
};

const fixUntilSettled = (oxlint, checkout, file) => {
    let previous = readFileSync(file, `utf8`);
    for (let pass = 0; pass < FIX_PASSES; pass++) {
        try {
            execFileSync(oxlint, [`--fix`, `--silent`, `-c`, join(checkout, `.oxlintrc.json`), `--no-error-on-unmatched-pattern`, file], {
                cwd: checkout,
                stdio: `ignore`,
                timeout: OXLINT_TIMEOUT_MS,
            });
        } catch {
            // Non-zero means problems remain, which is the normal state between passes.
        }
        const now = readFileSync(file, `utf8`);
        if (now === previous) {
            return;
        }
        previous = now;
    }
};

const gitIn = (checkout, ...args) => execFileSync(`git`, args, { cwd: checkout, encoding: `buffer`, stdio: [`ignore`, `pipe`, `ignore`] });

// Diagnostics of the file as HEAD holds it: none when HEAD lacks the file (all of it is this edit's), undefined when git cannot answer.
const baselineOf = (oxlint, checkout, rel) => {
    let head;
    try {
        head = gitIn(checkout, `show`, `HEAD:${rel}`);
    } catch {
        try {
            gitIn(checkout, `cat-file`, `-e`, `HEAD`);
            return [];
        } catch {
            return undefined;
        }
    }
    // Same basename, so filename-shaped overrides (`**/*.test.ts`) still apply; outside the tree, so no full lint reads it.
    const scratch = mkdtempSync(join(tmpdir(), `oxlint-baseline-`));
    try {
        const copy = join(scratch, basename(rel));
        writeFileSync(copy, head);
        return lint(oxlint, checkout, copy) ?? [];
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
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
        return `  ${rel}${position(text, d.labels?.[0]?.span?.offset)}  ${d.code}\n     ${d.message.replaceAll(`\n`, ` `)}${help}`;
    });
    return (
        `oxlint: ${fresh.length} new problem${fresh.length === 1 ? `` : `s`} in ${rel}, introduced by this edit; everything autofixable is already fixed.\n\n` +
        `${lines.join(`\n`)}\n\n` +
        `Each rule's reason is in .oxlintrc.json. If one is wrong here, say so rather than adding a disable comment ` +
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

    fixUntilSettled(oxlint, checkout, file);
    const current = (lint(oxlint, checkout, file) ?? []).filter((d) => !DEFERRED.has(d.code));
    if (current.length === 0) {
        return 0;
    }
    const baseline = baselineOf(oxlint, checkout, rel);
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
