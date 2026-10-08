#!/usr/bin/env node
// CI'S SIDE OF THE SANDBOX CACHE: before a job's turbo run, copy into the job's cache the results sandboxes already
// recorded for this exact tree, so a typecheck an agent ran before the push is a cache hit here instead of minutes.
//
//   node _tools/turbo-cache/import.mjs [--from <dir>] -- <the job's own turbo arguments>
//
// The job's arguments go through a dry run in the job's own environment, which is what makes the copy safe. An entry is
// taken only when CI's own turbo, hashing CI's own checkout, gives its hash to a task that declares no outputs, and only
// as the one log that task writes (artifact.mjs re-reads and re-writes it). An entry a sandbox filed under a build's hash
// is never looked at, so nothing a sandbox wrote can become a file in a build. What a sandbox can do is vouch for a
// typecheck or test result on a tree it ran; CI replays that result as it would its own.
//
// Never fails the job: an import that cannot run leaves the cache as it was, and the turbo run after it does the work.
// `--from` defaults to TURBO_CACHE_SANDBOX_DIR, else /ci-cache/turbo-sandbox (the cache server's write directory); the
// destination is TURBO_CACHE_DIR, the directory the job's turbo reads.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../constants/src/node.mjs";
import { canonicalArtifact } from "./artifact.mjs";
import { dryRunTasks, isOutputLess } from "./dry-run.mjs";
import { hasEntry, readEntry, writeEntry } from "./store.mjs";

/** Copies what `from` holds for the output-less tasks among `tasks` into `into`. Returns the counts and refusals. */
export const importResults = (tasks, from, into) => {
    const result = { considered: 0, held: 0, imported: [], refused: [] };
    for (const task of tasks.filter(isOutputLess)) {
        result.considered += 1;
        if (hasEntry(into, task.hash)) {
            result.held += 1;
            continue;
        }
        const entry = readEntry(from, task.hash);
        if (entry === undefined) {
            continue;
        }
        const artifact = canonicalArtifact(entry.body, { expect: task.logFile });
        if (!artifact.ok) {
            result.refused.push(`${task.taskId}: ${artifact.reason}`);
            continue;
        }
        writeEntry(into, task.hash, artifact.body, entry.durationMs);
        result.imported.push(task.taskId);
    }
    return result;
};

const parse = (argv) => {
    const split = argv.indexOf("--");
    const own = split === -1 ? argv : argv.slice(0, split);
    const from = own.includes("--from") ? own[own.indexOf("--from") + 1] : undefined;
    return { from, turboArgs: split === -1 ? [] : argv.slice(split + 1) };
};

const main = (argv) => {
    const { from = process.env.TURBO_CACHE_SANDBOX_DIR ?? "/ci-cache/turbo-sandbox", turboArgs } = parse(argv);
    const into = process.env.TURBO_CACHE_DIR;
    const say = (line) => console.log(`turbo-cache import: ${line}`);
    if (into === undefined || into === "") {
        return say("no TURBO_CACHE_DIR, so there is no cache to import into");
    }
    if (turboArgs.length === 0) {
        return say("no turbo arguments after `--`, so nothing says which tasks this job runs");
    }
    if (!existsSync(from)) {
        return say(`${from} does not exist, so no sandbox has recorded anything yet`);
    }
    let tasks;
    try {
        tasks = dryRunTasks(repoRoot(import.meta.url), turboArgs);
    } catch (error) {
        return say(`skipped, the dry run failed: ${String(error?.message ?? error)}`);
    }
    const result = importResults(tasks, from, into);
    say(
        `${result.imported.length} sandbox result(s) imported for ${result.considered} output-less task(s), ` +
            `${result.held} already cached, ${result.refused.length} refused`,
    );
    for (const taskId of result.imported) {
        say(`  imported ${taskId}`);
    }
    for (const refusal of result.refused) {
        say(`  refused ${refusal}`);
    }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        // An import is an optimisation: whatever went wrong, the job's own run does the work.
        console.log(`turbo-cache import: skipped after an error: ${String(error?.stack ?? error)}`);
    }
}
