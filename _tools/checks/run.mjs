#!/usr/bin/env node
// Runs the checks manifest.mjs lists as concurrent child processes, needing only node and git, no install. Exit code
// follows each check's `gate`: a `code` failure always fails the run; a `tidy` one does too unless `--tidy=warn`, used
// where many hands are moving the tree at once.
//
// `--paths a,b,c` narrows the run to those files and to the checks that can honestly judge a file on its own
// (`scoped` in the manifest). That is what the per-edit moment runs: one file, ~100ms, a verdict the model that just
// wrote the line can still act on. It is a NARROWER question, not a cheaper one — a scoped run vouches for nothing it
// did not read, and no scoped check may write a baseline, since it knows nothing about the files it skipped.
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
        console.log(`${check.id.padEnd(20)} ${check.needs.padEnd(13)} ${check.gate.padEnd(5)} ${(check.scoped === true ? "per-file" : "whole-tree").padEnd(11)} ${check.about}`);
    }
    process.exit(0);
}

const only = option("--only");
const skip = new Set(option("--skip") ?? []);
const gate = setting("--gate");
const tidyWarns = setting("--tidy") === "warn";
const json = args.includes("--json");
// Repo-relative paths to judge. Present and empty is a real answer (nothing this run can judge), not a request for the
// whole tree, so this keeps `[]` rather than collapsing it to `undefined`.
const paths = args.includes("--paths") ? (option("--paths") ?? []) : undefined;
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
    (check) =>
        (only === undefined || only.includes(check.id)) &&
        !skip.has(check.id) &&
        (gate === undefined || check.gate === gate) &&
        (paths === undefined || check.scoped === true),
);
// Nothing to say rather than nothing wrong: a per-edit run on a file no scoped check reads must be silent, and it must
// not print a green line claiming the tree was measured.
if (paths !== undefined && (paths.length === 0 || selected.length === 0)) {
    process.exit(0);
}

const run = (check) =>
    new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [join(here, check.file), ...(paths === undefined ? [] : ["--paths", paths.join(",")])], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        // `measured: false` is exit 2 (lib/report.mjs's cannotMeasure) or a process that never started: the check did not
        // judge the tree, so nothing it printed is a finding about the tree and no caller may treat it as one.
        const settle = (ok, extra = "", measured = true) =>
            resolve({ id: check.id, file: check.file, gate: check.gate, ok, measured, stdout, stderr: `${stderr}${extra}`, ms: Date.now() - started });
        child.on("error", (error) => settle(false, `${error.message}\n`, false));
        child.on("close", (code) => settle(code === 0, "", code !== 2));
    });

const started = Date.now();
const results = await Promise.all(selected.map(run));
// A failure that refuses rather than merely reports: every code failure, and a tidy one unless `--tidy=warn`. A check
// that could not measure refuses where a tidy one does and nowhere else — it is not evidence the tree is broken, so it
// must not stop a push or a turn, but it cannot be silent either, or the gate quietly stops testing what it was for.
const refuses = (result) => !result.ok && (!tidyWarns || (result.measured && result.gate === "code"));
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// `process.exitCode`, not `process.exit`: stdout to a pipe is async, so exiting immediately can truncate a large result
// and have the caller misread a real failure as unmeasurable.
if (json) {
    console.log(JSON.stringify(results));
    process.exitCode = results.some(refuses) ? 1 : 0;
} else if (paths !== undefined) {
    // The per-edit voice: only a problem speaks. A check's vouched line counts what it read, and under `--paths` that
    // is "1 template: every button is <Button>" after every single edit — a sentence that is true, useless, and paid
    // for out of the model's context. A scoped run that found nothing says nothing and exits 0.
    // A check that could not measure is dropped here and nowhere else: one edit is the wrong occasion to learn that a
    // tool moved, it would say so after every edit for the rest of the turn, and the turn and the nightly both still
    // report it.
    const failed = results.filter((result) => !result.ok && result.measured);
    for (const result of failed) {
        process.stderr.write(`${result.stderr}${result.stdout}`);
    }
    if (failed.length > 0) {
        // Named, because the finding is in the file just edited but not necessarily on the line just written: a
        // standing violation in a file a turn touches surfaces here too, and that is worth knowing rather than
        // worth hiding. Fixing either costs a line now and a red pipeline tomorrow.
        process.stderr.write(`\nIn the file just edited. Fix it here, or it is found on main by \`nightly.yml\`'s tidy job, where no turn can be sent back for it.\n`);
        process.exitCode = 1;
    }
} else {
    for (const result of results) {
        if (result.ok) {
            process.stdout.write(result.stdout);
        } else if (!result.measured) {
            process.stderr.write(`\n? ${result.id} (${result.file}) COULD NOT MEASURE, so this run vouches for nothing it covers — this is about the check, not the tree\n${result.stderr}${result.stdout}`);
        } else if (refuses(result)) {
            process.stderr.write(`\n✗ ${result.id} (${result.file})\n${result.stderr}${result.stdout}`);
        } else {
            process.stderr.write(`\n⚠ ${result.id} (${result.file}), a tidy rule: worth fixing, not what stops this run\n${result.stderr}${result.stdout}`);
        }
    }
    // Three outcomes, counted once each: a check that could not measure is neither a pass nor a tidy finding, and
    // counting it as both is how a broken tool reads as a dirty tree in the one line most readers stop at.
    const unmeasured = results.filter((result) => !result.measured);
    const failed = results.filter((result) => result.measured && refuses(result));
    const warned = results.filter((result) => result.measured && !result.ok && !refuses(result));
    const named = (label, group) => (group.length === 0 ? "" : `, ${group.length} ${label} (${group.map(({ id }) => id).join(", ")})`);
    const summary =
        `${results.filter(({ ok }) => ok).length} passed${ 
        named(`tidy warning${warned.length === 1 ? "" : "s"}`, warned) 
        }${named("unmeasured", unmeasured)}`;
    // An unmeasured check refuses where a tidy one does (see `refuses`), and says so in its own words: "failed" would
    // claim it looked.
    const stops = [...failed, ...unmeasured.filter(refuses)];
    if (stops.length > 0) {
        console.error(`\nchecks: ${stops.length} of ${results.length} stopped this run in ${seconds}s: ${stops.map(({ id }) => id).join(", ")}; ${summary}`);
        process.exitCode = 1;
    } else {
        console.log(`checks: ${summary} in ${seconds}s`);
    }
}
