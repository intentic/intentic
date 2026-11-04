import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditTurboHits } from "./cache-audit.mjs";

const AUDIT = fileURLToPath(new URL("./cache-audit.mjs", import.meta.url));

test("Turbo audits re-execute only sampled hits and preserve failures", () => {
    const summary = {
        tasks: [
            { taskId: "pkg#a", task: "a", cache: { status: "HIT" } },
            { taskId: "pkg#b", task: "b", cache: { status: "HIT" } },
            { taskId: "pkg#miss", task: "miss", cache: { status: "MISS" } },
        ],
    };
    const executed = [];
    const audits = auditTurboHits(summary, 2, "run", "attempt", (task) => {
        executed.push(task.taskId);
        return task.task === "a" ? 1 : 0;
    });
    assert.deepEqual(
        audits.map((audit) => audit.task),
        executed,
    );
    assert.equal(audits.length, 2);
    assert.ok(!executed.includes("pkg#miss"));
    assert.deepEqual(
        auditTurboHits(summary, 2, "run", "attempt", () => 0),
        audits.map((audit) => ({ ...audit, exitCode: 0 })),
    );
});

test("a run that wrote no summary audits nothing and passes", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-audit-"));
    try {
        const ran = spawnSync("node", [AUDIT, join(root, "runs")], { cwd: root, encoding: "utf8" });
        assert.equal(ran.status, 0, ran.stderr);
        assert.match(ran.stdout, /nothing audited/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
