// Pins the sizing rule: what a box's memory affords at four concurrent turbo tasks, capped by its cpus, never fewer
// than one, and a caller's own value kept.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cgroupMemoryLimit, hostJobs, standaloneWorkers, testWorkers, workersFor } from "./test-workers.mjs";

const GIB = 1024 ** 3;
const CORES = 16;

test("workers follow the memory ceiling, capped by the cpus, one at least", () => {
    assert.equal(workersFor(16 * GIB, CORES), 2);
    assert.equal(workersFor(8 * GIB, CORES), 1);
    assert.equal(workersFor(2 * GIB, CORES), 1);
    assert.equal(workersFor(1 * GIB, CORES), 1);
    assert.equal(workersFor(128 * GIB, CORES), CORES);
    assert.equal(workersFor(16 * GIB, 4), 2);
});

// The regression that took the fleet down: six jobs on one 26 GB box, each sizing itself as though the box were its
// own, is ~144 bun workers where the memory affords 24.
test("the box is divided by the jobs sharing it, never handed to each of them whole", () => {
    assert.equal(workersFor(128 * GIB, CORES, 1), CORES);
    assert.equal(workersFor(128 * GIB, CORES, 6), 2);
    assert.equal(workersFor(26 * GIB, CORES, 6), 1);
    assert.equal(workersFor(16 * GIB, CORES, 2), 1);
});

test("a lone package run takes half the box at a web worker's size, capped by the cpus", () => {
    assert.equal(standaloneWorkers(16 * GIB, CORES, 1), 4);
    assert.equal(standaloneWorkers(8 * GIB, CORES, 1), 2);
    assert.equal(standaloneWorkers(2 * GIB, CORES, 1), 1);
    assert.equal(standaloneWorkers(64 * GIB, 8, 1), 8);
    assert.equal(standaloneWorkers(64 * GIB, 8, 6), 2);
});

test("the jobs sharing a host are read from the environment, and absent means alone", () => {
    assert.equal(hostJobs({ CI_HOST_JOBS: "6" }), 6);
    assert.equal(hostJobs({}), 1);
    assert.equal(hostJobs({ CI_HOST_JOBS: "" }), 1);
    assert.equal(hostJobs({ CI_HOST_JOBS: "not a number" }), 1);
    assert.equal(hostJobs({ CI_HOST_JOBS: "0" }), 1);
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
