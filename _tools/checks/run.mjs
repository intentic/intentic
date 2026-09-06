#!/usr/bin/env node
/* RUN THE CHECKS THE MANIFEST LISTS, side by side, and say what each one found.
 *
 *   node _tools/checks/run.mjs                    every check, every failure refuses (CI's preflight, `pnpm checks`)
 *   node _tools/checks/run.mjs --tidy=warn        every check; a failing `tidy` check is a warning, not a refusal
 *   node _tools/checks/run.mjs --gate=code        only the checks whose gate is `code` (or `tidy`)
 *   node _tools/checks/run.mjs --only paths,rows  some of them
 *   node _tools/checks/run.mjs --skip vue-templates
 *   node _tools/checks/run.mjs --json             one JSON array of verdicts on stdout, for a caller that compares runs
 *   node _tools/checks/run.mjs --list             the manifest, one line each
 *
 * Needs node and git and nothing else: this is what CI's preflight job runs before its install and what the
 * pre-push hook runs on a clone that may never have installed. Each check is a child process (lib/report.mjs
 * is the contract), all started at once; the whole set is under two seconds on a warm disk, and one that
 * misbehaves cannot take the others' verdicts with it. Output is repeated in manifest order so a failing run
 * reads the same way every time.
 *
 * WHAT DECIDES THE EXIT CODE is the check's `gate` (manifest.mjs says what the two mean). A `code` failure is
 * exit 1 wherever this runs. A `tidy` failure is exit 1 by default and a printed warning under `--tidy=warn`,
 * which is how the push gate, the post-land `pnpm verify` and the prepass run it: those measure a tree many
 * hands are moving, and a tidy rule red for a directory nobody in this push touched must not stop the push.
 * `--gate=` is for the two CI jobs that split the list between them, so each reads one commit and refuses on
 * its own account. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { CHECKS } from "./manifest.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : (args[at + 1] ?? "").split(",").filter(Boolean);
};
// `--name=value` flags, for the two that take one word.
const setting = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

if (args.includes("--list")) {
    for (const check of CHECKS) {
        console.log(`${check.id.padEnd(20)} ${check.needs.padEnd(13)} ${check.gate.padEnd(5)} ${check.about}`);
    }
    process.exit(0);
}

const only = option("--only");
const skip = new Set(option("--skip") ?? []);
const gate = setting("--gate");
const tidyWarns = setting("--tidy") === "warn";
const json = args.includes("--json");
const unknown = [...(only ?? []), ...skip].filter((id) => !CHECKS.some((check) => check.id === id));
if (unknown.length > 0) {
    console.error(`checks: no such check ${unknown.join(", ")} (see --list)`);
    process.exit(2);
}
if (gate !== undefined && gate !== "code" && gate !== "tidy") {
    console.error(`checks: --gate takes code or tidy, not ${gate}`);
    process.exit(2);
}
const selected = CHECKS.filter(
    (check) => (only === undefined || only.includes(check.id)) && !skip.has(check.id) && (gate === undefined || check.gate === gate),
);

const run = (check) =>
    new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [join(here, check.file)], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const settle = (ok, extra = "") =>
            resolve({ id: check.id, file: check.file, gate: check.gate, ok, stdout, stderr: `${stderr}${extra}`, ms: Date.now() - started });
        child.on("error", (error) => settle(false, `${error.message}\n`));
        child.on("close", (code) => settle(code === 0));
    });

const started = Date.now();
const results = await Promise.all(selected.map(run));
// A failure that REFUSES, as opposed to one that is only reported: every code failure, and a tidy one unless
// the caller asked for tidy to warn.
const refuses = (result) => !result.ok && (result.gate === "code" || !tidyWarns);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

/* `process.exitCode` and a natural exit, NOT `process.exit`: every check's whole stdout and stderr is inside
 * this blob, so it is tens of kilobytes, and stdout to a pipe is asynchronous in node. `console.log` followed
 * by `process.exit` truncates it at whatever the pipe buffer took — which the caller then reads as a JSON parse
 * error, on the red path, where it would be reported as "the checks could not be measured" instead of as the
 * failure they actually found. */
if (json) {
    console.log(JSON.stringify(results));
    process.exitCode = results.some(refuses) ? 1 : 0;
} else {
    for (const result of results) {
        if (result.ok) {
            process.stdout.write(result.stdout);
        } else if (refuses(result)) {
            process.stderr.write(`\n✗ ${result.id} (${result.file})\n${result.stderr}${result.stdout}`);
        } else {
            process.stderr.write(`\n⚠ ${result.id} (${result.file}), a tidy rule: worth fixing, not what stops this run\n${result.stderr}${result.stdout}`);
        }
    }
    const failed = results.filter(refuses);
    const warned = results.filter((result) => !result.ok && !refuses(result));
    const summary = `${results.length - failed.length - warned.length} passed${warned.length > 0 ? `, ${warned.length} tidy warning${warned.length === 1 ? "" : "s"} (${warned.map(({ id }) => id).join(", ")})` : ""}`;
    if (failed.length > 0) {
        console.error(`\nchecks: ${failed.length} of ${results.length} failed in ${seconds}s: ${failed.map(({ id }) => id).join(", ")}${warned.length > 0 ? `; ${summary}` : ""}`);
        process.exitCode = 1;
    } else {
        console.log(`checks: ${summary} in ${seconds}s`);
    }
}
