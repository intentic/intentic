// Pins the sizing rule: the tuned four on a 16 GiB box, fewer where less fits, never more, and a caller's own value kept.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cgroupMemoryLimit, MAX_WORKERS, vitestMaxWorkers, workersFor } from "./vitest-workers.mjs";

const GIB = 1024 ** 3;

test("workers follow the memory ceiling: four at 16 GiB, fewer below, never more above, one at least", () => {
    assert.equal(workersFor(16 * GIB), 4);
    assert.equal(workersFor(12 * GIB), 3);
    assert.equal(workersFor(8 * GIB), 2);
    assert.equal(workersFor(7 * GIB), 1);
    assert.equal(workersFor(4 * GIB), 1);
    assert.equal(workersFor(64 * GIB), MAX_WORKERS);
    assert.equal(workersFor(undefined), MAX_WORKERS);
});

test("the cgroup ceiling is read as bytes; `max`, a missing file or a bad number are no ceiling", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-max-"));
    let files = 0;
    const file = (text) => {
        const path = join(dir, `memory.max.${(files += 1)}`);
        writeFileSync(path, text);
        return path;
    };
    assert.equal(cgroupMemoryLimit(file("17179869184\n")), 16 * GIB);
    assert.equal(cgroupMemoryLimit(file("max\n")), undefined);
    assert.equal(cgroupMemoryLimit(file("not a number")), undefined);
    assert.equal(cgroupMemoryLimit(join(dir, "absent")), undefined);
});

test("a caller's own VITEST_MAX_WORKERS wins, and an empty one is unset", () => {
    assert.equal(vitestMaxWorkers({ VITEST_MAX_WORKERS: "2" }, 16 * GIB), "2");
    assert.equal(vitestMaxWorkers({}, 8 * GIB), "2");
    assert.equal(vitestMaxWorkers({ VITEST_MAX_WORKERS: "" }, 16 * GIB), "4");
});
