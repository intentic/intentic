import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditMarkdown, cacheMarkdown, sampledTurboHits, summaryAt, turboCacheStats } from "./cache-report.mjs";

const REPORT = fileURLToPath(new URL("./cache-report.mjs", import.meta.url));

test("cache reports distinguish task savings from elapsed time and cache source", () => {
    const turbo = {
        execution: { startTime: 1000, endTime: 2500 },
        tasks: [
            { cache: { status: "HIT", local: true, remote: false, timeSaved: 9000 } },
            { cache: { status: "HIT", local: false, remote: true, timeSaved: 2000 } },
            { cache: { status: "MISS", local: false, remote: false, timeSaved: 0 } },
        ],
    };
    assert.deepEqual(turboCacheStats(turbo), { tasks: 3, hits: 2, local: 1, remote: 1, savedMs: 11000, elapsedMs: 1500 });
    assert.match(cacheMarkdown("Turbo", turboCacheStats(turbo)), /2\/3 tasks hit \(1 local, 1 remote\); 11\.0s task runtime avoided; 1\.5s elapsed/);
    assert.match(auditMarkdown([{ exitCode: 0 }, { exitCode: 1 }]), /2 cached results re-executed without cache reads or remote access; 1 failed/);
    assert.match(auditMarkdown([{ exitCode: 0 }]), /1 cached result re-executed/);
});

test("cache-hit audits are deterministic for a run and independent of summary order", () => {
    const hit = (name) => ({ taskId: `pkg#${name}`, package: "pkg", task: name, cache: { status: "HIT" } });
    const summary = { tasks: [hit("a"), hit("b"), hit("c"), { taskId: "pkg#miss", cache: { status: "MISS" } }] };
    const selected = sampledTurboHits(summary, 2, "run", "attempt").map((task) => task.taskId);
    assert.deepEqual(
        selected,
        sampledTurboHits({ tasks: summary.tasks.toReversed() }, 2, "run", "attempt").map((task) => task.taskId),
    );
    assert.equal(selected.length, 2);
    assert.throws(() => sampledTurboHits(summary, -1), /non-negative integer/);
});

test("summaryAt picks this run's summary, excluding older and non-JSON files", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-summary-"));
    try {
        const old = join(root, "old.json");
        const current = join(root, "current.json");
        writeFileSync(old, "{}");
        writeFileSync(current, "{}");
        writeFileSync(join(root, "newer.txt"), "not a summary");
        utimesSync(old, 1, 1);
        utimesSync(current, 10, 10);
        assert.equal(summaryAt(root, 5000), current);
        assert.equal(summaryAt(join(root, "missing"), 0), undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the report clears the runs directory it read, so fleet checkouts do not accumulate summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-report-"));
    try {
        const runs = join(root, "runs");
        mkdirSync(runs);
        writeFileSync(join(runs, "earlier.json"), "{}");
        utimesSync(join(runs, "earlier.json"), 1, 1);
        writeFileSync(join(runs, "current.json"), JSON.stringify({ tasks: [{ cache: { status: "HIT", local: true } }] }));
        const copy = join(root, "artifact", "turbo.json");
        const ran = spawnSync("node", [REPORT, runs, copy], { encoding: "utf8", env: { ...process.env, CACHE_RUN_STARTED: "5000" } });
        assert.equal(ran.status, 0);
        assert.match(ran.stdout, /1\/1 tasks hit/);
        assert.ok(existsSync(copy));
        assert.deepEqual(readdirSync(runs), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
