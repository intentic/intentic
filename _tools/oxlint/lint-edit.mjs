#!/usr/bin/env node
// `node _tools/oxlint/lint-edit.mjs <file>`: autofixes the file silently, then reports only the diagnostics its HEAD
// version did not have, under the root rules and the plugin tier (.oxlintrc.plugins.json, added.mjs). Exit 2 with the
// report, else 0, including whenever it cannot measure (no binary, no git).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { diagnosticsOf, introduced, LINTABLE, OXLINT_TIMEOUT_MS, oxlintIn, PLUGINS_CONFIG, report as lintReport, ROOT_CONFIG } from "./added.mjs";

// Rules a half-written file trips honestly; `pnpm lint` still reads them in the check after the land and at the push.
const DEFERRED = new Set([`eslint(no-unused-vars)`]);

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
// the root config ignores is not judged at all, as `pnpm lint` does not judge it.
const configOf = (checkout) => (existsSync(join(checkout, PLUGINS_CONFIG)) ? PLUGINS_CONFIG : ROOT_CONFIG);
const lint = (oxlint, checkout, file) =>
    lintReport(oxlint, checkout, ROOT_CONFIG, file)?.files === 0 ? [] : lintReport(oxlint, checkout, configOf(checkout), file)?.diagnostics;

const fixUntilSettled = (oxlint, checkout, file) => {
    let previous = readFileSync(file, `utf8`);
    for (let pass = 0; pass < FIX_PASSES; pass++) {
        try {
            execFileSync(oxlint, [`--fix`, `--silent`, `-c`, join(checkout, ROOT_CONFIG), `--no-error-on-unmatched-pattern`, file], {
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
    return diagnosticsOf(oxlint, checkout, configOf(checkout), rel, head) ?? [];
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
