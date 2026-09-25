// Pins the sizing rule: what the free memory affords at four concurrent turbo tasks, capped by the cpus, never fewer
// than one, and a caller's own value kept.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { freeBytesOf, readReadingSync, ROOM_SOCKET } from "../../constants/src/memory-room.mjs";
import { availableMemory, hostJobs, standaloneWorkers, testWorkers, typecheckConcurrency, workersFor } from "./test-workers.mjs";

const GIB = 1024 ** 3;
const CORES = 16;

test("workers follow the free memory, capped by the cpus, one at least", () => {
    assert.equal(workersFor(24 * GIB, CORES), 2);
    assert.equal(workersFor(16 * GIB, CORES), 1);
    assert.equal(workersFor(2 * GIB, CORES), 1);
    assert.equal(workersFor(1 * GIB, CORES), 1);
    assert.equal(workersFor(128 * GIB, CORES), 10);
    assert.equal(workersFor(256 * GIB, CORES), CORES);
    assert.equal(workersFor(24 * GIB, 1), 1);
});

// The regression that took the fleet down: six jobs on one 26 GB box, each sizing itself as though the box were its
// own, is ~144 bun workers where the memory affords 24.
test("the box is divided by the jobs sharing it, never handed to each of them whole", () => {
    assert.equal(workersFor(256 * GIB, CORES, 1), CORES);
    assert.equal(workersFor(256 * GIB, CORES, 6), 3);
    assert.equal(workersFor(26 * GIB, CORES, 6), 1);
    assert.equal(workersFor(16 * GIB, CORES, 2), 1);
});

test("a lone package run takes half of what is free at a web worker's size, capped by the cpus", () => {
    assert.equal(standaloneWorkers(16 * GIB, CORES, 1), 2);
    assert.equal(standaloneWorkers(8 * GIB, CORES, 1), 1);
    assert.equal(standaloneWorkers(2 * GIB, CORES, 1), 1);
    assert.equal(standaloneWorkers(64 * GIB, 8, 1), 8);
    assert.equal(standaloneWorkers(64 * GIB, 8, 6), 1);
});

test("typecheck tasks run two gigabytes of free memory apiece, never past turbo's four", () => {
    assert.equal(typecheckConcurrency(3 * GIB, 1), 1);
    assert.equal(typecheckConcurrency(1 * GIB, 1), 1);
    assert.equal(typecheckConcurrency(5 * GIB, 1), 2);
    assert.equal(typecheckConcurrency(64 * GIB, 1), 4);
    assert.equal(typecheckConcurrency(12 * GIB, 2), 3);
});

test("the jobs sharing a host are read from the environment, and absent means alone", () => {
    assert.equal(hostJobs({ CI_HOST_JOBS: "6" }), 6);
    assert.equal(hostJobs({}), 1);
    assert.equal(hostJobs({ CI_HOST_JOBS: "" }), 1);
    assert.equal(hostJobs({ CI_HOST_JOBS: "not a number" }), 1);
    assert.equal(hostJobs({ CI_HOST_JOBS: "0" }), 1);
});

// The figure is the one room formula's (memory-room.test.ts pins the formula): asked of the daemon's socket where one
// answers, else read off the same files, so the fan-out and the gate that holds a turn never disagree about room.
test("free memory is the room formula's free memory, asked once per process", () => {
    const first = availableMemory();
    assert.equal(availableMemory(), first);
    const formula = freeBytesOf(readReadingSync());
    if (formula !== undefined && !existsSync(ROOM_SOCKET)) {
        assert.ok(Math.abs(first - formula) < 512 * 1024 ** 2, `${first} is the formula's ${formula}, give or take what moved since`);
    }
});

test("a caller's own TEST_WORKERS wins, and an empty one is unset", () => {
    assert.equal(testWorkers({ TEST_WORKERS: "2" }, 16 * GIB), "2");
    assert.equal(testWorkers({ TEST_WORKERS: "" }, 2 * GIB), "1");
});
