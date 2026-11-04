#!/usr/bin/env node
// Cache measurements from a turbo run summary. The verify job's last reader of `.turbo/runs`, so it also clears them.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { newestSummary } from "./failure-units.mjs";

const finite = (value) => (Number.isFinite(value) ? value : 0);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export const turboCacheStats = (summary) => {
    const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
    const hits = tasks.filter((task) => task.cache?.status === "HIT");
    return {
        tasks: tasks.length,
        hits: hits.length,
        local: hits.filter((task) => task.cache?.local === true).length,
        remote: hits.filter((task) => task.cache?.remote === true).length,
        savedMs: hits.reduce((total, task) => total + finite(task.cache?.timeSaved), 0),
        elapsedMs: Math.max(0, finite(summary?.execution?.endTime) - finite(summary?.execution?.startTime)),
    };
};

export const sampledTurboHits = (summary, count, runId = "local", attempt = "1") => {
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Cache audit count must be a non-negative integer");
    }
    const rank = (task) => createHash("sha256").update(`${runId}:${attempt}:${task.taskId}`).digest("hex");
    return (Array.isArray(summary?.tasks) ? summary.tasks : [])
        .filter((task) => task.cache?.status === "HIT")
        .toSorted((a, b) => rank(a).localeCompare(rank(b)))
        .slice(0, count);
};

export const cacheMarkdown = (label, stats) =>
    `### ${label} cache\n\n${stats.hits}/${stats.tasks} tasks hit (${stats.local} local, ${stats.remote} remote); ${(stats.savedMs / 1000).toFixed(1)}s task runtime avoided; ${(stats.elapsedMs / 1000).toFixed(1)}s elapsed.\n\n`;

export const auditMarkdown = (audits) =>
    `### Turbo cache-hit audit\n\n${plural(audits.length, "cached result")} re-executed without cache reads or remote access; ` +
    `${audits.filter((audit) => audit.exitCode !== 0).length} failed.\n\n`;

// The summary a path names: the file itself, or the newest one in a runs directory written since this run's turbo started.
export const summaryAt = (path, since) => {
    if (!existsSync(path)) {
        return undefined;
    }
    return statSync(path).isDirectory() ? newestSummary(path, since) : path;
};

// Runs directories outlive the job on fleet checkouts (`clean: false`), so whatever is left there once this job's summary
// is read came from an earlier job: drop it all, keeping the directory from growing with every push.
export const clearSummaries = (directory) => {
    for (const name of readdirSync(directory)) {
        if (name.endsWith(".json")) {
            rmSync(join(directory, name), { force: true });
        }
    }
};

export const writeJson = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
};

const main = (args) => {
    const [suppliedPath, copyTo] = args;
    if (suppliedPath === undefined) {
        throw new Error("Usage: cache-report.mjs <turbo-summary.json|runs-directory> [artifact-copy.json]");
    }
    const summaryPath = summaryAt(suppliedPath, Number(process.env.CACHE_RUN_STARTED ?? 0));
    if (summaryPath === undefined) {
        throw new Error("No Turbo summary was written for this run");
    }
    try {
        const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
        if (copyTo !== undefined) {
            mkdirSync(dirname(copyTo), { recursive: true });
            copyFileSync(summaryPath, copyTo);
        }
        return cacheMarkdown("Turbo", turboCacheStats(summary));
    } finally {
        if (statSync(suppliedPath).isDirectory()) {
            clearSummaries(suppliedPath);
        }
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        process.stdout.write(main(process.argv.slice(2)));
    } catch (error) {
        // Telemetry is never the reason a measured task fails.
        process.stderr.write(`cache report unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
}
