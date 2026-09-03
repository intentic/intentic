#!/usr/bin/env node
/* RUN THE CHECKS THE MANIFEST LISTS, side by side, and say what each one found.
 *
 *   node _tools/checks/run.mjs                    every check
 *   node _tools/checks/run.mjs --only paths,rows  some of them
 *   node _tools/checks/run.mjs --skip vue-templates
 *   node _tools/checks/run.mjs --list             the manifest, one line each
 *
 * Needs node and git and nothing else: this is what CI's preflight job runs before its install and what the
 * pre-push hook runs on a clone that may never have installed. Each check is a child process (lib/report.mjs
 * is the contract), all started at once; the whole set is under two seconds on a warm disk, and one that
 * misbehaves cannot take the others' verdicts with it. Output is repeated in manifest order so a failing run
 * reads the same way every time. Exit 1 if any check failed. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { CHECKS } from "./manifest.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : (args[at + 1] ?? "").split(",").filter(Boolean);
};

if (args.includes("--list")) {
    for (const check of CHECKS) {
        console.log(`${check.id.padEnd(20)} ${check.needs.padEnd(13)} ${check.about}`);
    }
    process.exit(0);
}

const only = option("--only");
const skip = new Set(option("--skip") ?? []);
const unknown = [...(only ?? []), ...skip].filter((id) => !CHECKS.some((check) => check.id === id));
if (unknown.length > 0) {
    console.error(`checks: no such check ${unknown.join(", ")} (see --list)`);
    process.exit(2);
}
const selected = CHECKS.filter((check) => (only === undefined || only.includes(check.id)) && !skip.has(check.id));

const run = (check) =>
    new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [join(here, check.file)], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => resolve({ check, ok: false, stdout, stderr: `${stderr}${error.message}\n`, ms: Date.now() - started }));
        child.on("close", (code) => resolve({ check, ok: code === 0, stdout, stderr, ms: Date.now() - started }));
    });

const started = Date.now();
const results = await Promise.all(selected.map(run));
for (const { check, ok, stdout, stderr } of results) {
    if (ok) {
        process.stdout.write(stdout);
        continue;
    }
    process.stderr.write(`\n✗ ${check.id} (${check.file})\n${stderr}${stdout}`);
}
const failed = results.filter((result) => !result.ok);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length > 0) {
    console.error(`\nchecks: ${failed.length} of ${results.length} failed in ${seconds}s: ${failed.map(({ check }) => check.id).join(", ")}`);
    process.exit(1);
}
console.log(`checks: ${results.length} passed in ${seconds}s`);
