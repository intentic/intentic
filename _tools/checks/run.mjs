#!/usr/bin/env node
// Runs the checks manifest.mjs lists as concurrent child processes, needing only node and git, no install. Exit code
// follows each check's `gate`: a `code` failure always fails the run; a `tidy` one does too unless `--tidy=warn`, used
// where many hands are moving the tree at once.
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
// A failure that refuses rather than merely reports: every code failure, and a tidy one unless `--tidy=warn`.
const refuses = (result) => !result.ok && (result.gate === "code" || !tidyWarns);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// `process.exitCode`, not `process.exit`: stdout to a pipe is async, so exiting immediately can truncate a large result
// and have the caller misread a real failure as unmeasurable.
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
