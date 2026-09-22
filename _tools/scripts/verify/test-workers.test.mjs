// Pins the sizing rule: what a box's memory affords at four concurrent turbo tasks, capped by its cpus, never fewer
// than one, and a caller's own value kept.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cgroupMemoryLimit, standaloneWorkers, testWorkers, workersFor } from "./test-workers.mjs";

const GIB = 1024 ** 3;
const CORES = 16;

test("workers follow the memory ceiling, capped by the cpus, one at least", () => {
    assert.equal(workersFor(16 * GIB, CORES), 2);
    assert.equal(workersFor(8 * GIB, CORES), 1);
    assert.equal(workersFor(2 * GIB, CORES), 1);
    assert.equal(workersFor(1 * GIB, CORES), 1);
    assert.equal(workersFor(128 * GIB, CORES), CORES);
    assert.equal(workersFor(16 * GIB, 4), 2);
    assert.equal(workersFor(undefined, CORES), CORES);
});

test("a lone package run takes half the box at a web worker's size, capped by the cpus", () => {
    assert.equal(standaloneWorkers(16 * GIB, CORES), 4);
    assert.equal(standaloneWorkers(8 * GIB, CORES), 2);
    assert.equal(standaloneWorkers(2 * GIB, CORES), 1);
    assert.equal(standaloneWorkers(64 * GIB, 8), 8);
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

test("a caller's own TEST_WORKERS wins, and an empty one is unset", () => {
    assert.equal(testWorkers({ TEST_WORKERS: "2" }, 16 * GIB), "2");
    assert.equal(testWorkers({ TEST_WORKERS: "" }, 2 * GIB), "1");
});
