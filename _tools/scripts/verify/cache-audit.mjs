#!/usr/bin/env node
// Re-execute a deterministic sample of Turbo hits without any cache reads or remote access.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { turboBin } from "../../turbo-cache/dry-run.mjs";
import { auditMarkdown, sampledTurboHits, summaryAt, writeJson } from "./cache-report.mjs";

export const auditTurboHits = (summary, count, runId, attempt, execute) =>
    sampledTurboHits(summary, count, runId, attempt).map((task) => ({ task: task.taskId, exitCode: execute(task) }));

const main = (args) => {
    const [suppliedPath, reportPath] = args;
    if (suppliedPath === undefined) {
        throw new Error("Usage: cache-audit.mjs <turbo-summary.json|runs-directory> [audit-report.json]");
    }
    const summaryPath = summaryAt(suppliedPath, Number(process.env.CACHE_RUN_STARTED ?? 0));
    if (summaryPath === undefined) {
        // A run with nothing to do writes no summary, and then there is no hit to audit: never fail a passing gate on it.
        process.stdout.write("### Turbo cache-hit audit\n\nNo Turbo summary was written for this run; nothing audited.\n\n");
        return;
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const count = Number(process.env.TURBO_CACHE_AUDIT ?? 1);
    const root = process.cwd();
    const bin = turboBin(root);
    if (bin === undefined) {
        throw new Error("Turbo is not installed");
    }
    const verification = auditTurboHits(summary, count, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, (task) => {
        process.stderr.write(`cache audit: re-executing ${task.taskId} without cache reads or remote access\n`);
        // stdout goes to the job summary (verify.yml redirects it), so the task's own output goes to the log on stderr.
        const result = spawnSync(bin, ["run", task.task, "--only", `--filter=${task.package}`, "--cache=local:w,remote:"], {
            cwd: root,
            env: process.env,
            stdio: ["ignore", 2, 2],
        });
        if (result.error !== undefined) {
            throw result.error;
        }
        return result.status ?? 1;
    });
    if (reportPath !== undefined) {
        writeJson(reportPath, { summary: summaryPath, verification });
    }
    process.stdout.write(auditMarkdown(verification));
    if (verification.some((audit) => audit.exitCode !== 0)) {
        process.exitCode = 1;
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2));
}
