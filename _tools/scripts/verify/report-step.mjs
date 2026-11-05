#!/usr/bin/env node
// A CI STEP WHOSE FINDINGS ARE REPORTED, NOT FAILED. It runs one command, passes its output through, and turns what it
// found into warning annotations on the lines it names and a block in the job's step summary (checks/lib/ci-report.mjs):
//
//   node _tools/scripts/verify/report-step.mjs --title "cargo fmt (ic)" -- cargo fmt --manifest-path … --check
//   node _tools/scripts/verify/report-step.mjs --title "clippy (ic)" --keep-status -- cargo clippy --manifest-path …
//
// Without `--keep-status` it exits 0 whatever the command said: `cargo fmt --check` fails only on formatting, which is
// style, and ci.yml's `autofix` job writes the fix itself. With it, it exits with the command's status: clippy without
// `-D warnings` still fails on a compile error and on the lints clippy denies by default (its `correctness` group: code
// that is outright wrong), while its warn-by-default groups (style, complexity, perf, suspicious) are reported. Over
// main's pushes 2026-10-23..11-05, `cargo fmt --check` failed desktop-check 3 times and netd-check once, and clippy's
// `-D warnings` failed ic-check once, each on a finding of the kind now reported.
//
// It reads rustfmt's `Diff in <file>:<line>:` and rustc's `warning: …` / `--> <file>:<line>:<col>` pairs, and any line
// in the `path:line: message` shape the repository's own checks print.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createReporter, locate } from "../../checks/lib/ci-report.mjs";

// rustfmt names a file it would change by its absolute path and the first line it would change.
const RUSTFMT_DIFF = /^Diff in (.+?)(?::(\d+):| at line (\d+):)\s*$/u;
// rustc's diagnostic head, and the arrow under it naming where it points; a head with no arrow (a crate's warning count)
// names no line.
const RUSTC_HEAD = /^(warning|error)(?:\[\w+\])?: (.+)$/u;
const RUSTC_ARROW = /^\s*--> (.+?):(\d+):(\d+)$/u;
// What a terminal colour leaves in a log, built from its code so no literal escape byte sits in this file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/** The findings `output` names, each `{ file, line?, col?, message }` with `file` as the tool printed it. */
export const findingsIn = (output) => {
    const found = [];
    let head;
    for (const raw of output.split("\n")) {
        const line = raw.replaceAll(ANSI, "").trimEnd();
        const diff = RUSTFMT_DIFF.exec(line);
        if (diff !== null) {
            found.push({ file: diff[1], line: Number(diff[2] ?? diff[3]), message: "not formatted as rustfmt would (cargo fmt writes it; ci.yml's autofix job pushes it on main)" });
            head = undefined;
            continue;
        }
        const started = RUSTC_HEAD.exec(line);
        if (started !== null) {
            head = `${started[1]}: ${started[2]}`;
            continue;
        }
        const arrow = RUSTC_ARROW.exec(line);
        if (arrow !== null && head !== undefined) {
            found.push({ file: arrow[1], line: Number(arrow[2]), col: Number(arrow[3]), message: head });
            head = undefined;
            continue;
        }
        const plain = locate(line);
        if (plain !== undefined && !line.startsWith(" ")) {
            found.push(plain);
        }
    }
    return found;
};

/**
 * `file` as a path from `root`: an absolute one made relative, a relative one looked for from `cwd` and each directory
 * above it, then from `extra` (a `--manifest-path`'s directory) and each above that, since cargo prints a path from the
 * workspace it built rather than from where it was run. Undefined when no candidate exists under `root`.
 */
export const fromRoot = (root, cwd, file, extra = []) => {
    if (isAbsolute(file)) {
        const rel = relative(root, file);
        return rel.startsWith("..") ? undefined : rel;
    }
    for (const start of [cwd, ...extra]) {
        for (let dir = resolve(start); ; dir = dirname(dir)) {
            const rel = relative(root, join(dir, file));
            if (!rel.startsWith("..") && existsSync(join(root, rel))) {
                return rel;
            }
            if (dir === root || dir === dirname(dir) || relative(root, dir).startsWith("..")) {
                break;
            }
        }
    }
    return undefined;
};

const argument = (args, name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const args = process.argv.slice(2);
    const split = args.indexOf("--");
    const own = split === -1 ? args : args.slice(0, split);
    const command = split === -1 ? [] : args.slice(split + 1);
    const title = argument(own, "--title");
    if (title === undefined || command.length === 0) {
        process.stderr.write("report-step: --title <title> [--keep-status] -- <command> [args…]\n");
        process.exit(2);
    }
    const keepStatus = own.includes("--keep-status");
    const cwd = process.cwd();
    const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).stdout?.trim() || cwd;
    const manifest = argument(command, "--manifest-path");
    const extra = manifest === undefined ? [] : [dirname(resolve(cwd, manifest))];

    // Streamed through as it comes, so a long build reads live in the log, and kept to be read once it ends.
    let output = "";
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
        output += chunk;
        process.stderr.write(chunk);
    });
    const status = await new Promise((done) => {
        child.on("error", (error) => {
            output += `${error.message}\n`;
            process.stderr.write(`report-step: ${command[0]} did not start: ${error.message}\n`);
            done(127);
        });
        child.on("close", (code) => done(code ?? 1));
    });

    const findings = findingsIn(output).flatMap((finding) => {
        const file = fromRoot(root, cwd, finding.file, extra);
        return file === undefined ? [] : [{ ...finding, file }];
    });
    const lines = findings.map(({ file, line, col, message }) => `${file}${line === undefined ? "" : `:${line}`}${col === undefined ? "" : `:${col}`}: ${message}`);
    if (status !== 0 || lines.length > 0) {
        const reporter = createReporter();
        reporter.annotate(title, lines);
        const verdict = keepStatus && status !== 0 ? `failed (exit ${status})` : status === 0 ? "passed with findings, reported" : `exit ${status}, reported and not failed`;
        reporter.summary(title, `${verdict} · \`${command.join(" ")}\``, lines);
        process.stderr.write(`report-step: ${title}: ${verdict}, ${lines.length} finding(s) annotated\n`);
    }
    process.exit(keepStatus ? status : 0);
}
