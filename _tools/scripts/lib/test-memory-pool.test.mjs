// Pins the pool's promises: a run takes its share of what is free and no more, what one run holds the next cannot take
// until it is released, nothing about a missing or broken pool ever stops a run, the reserved band is the gates' alone, a
// job's cap holds, and a run that waits for room waits no longer than it was given and keeps what it found.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireAtLeast, acquireSlots, poolOf } from "./test-memory-pool.mjs";

const scratch = mkdtempSync(join(tmpdir(), "test-memory-pool-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const poolNamed = (name, total, more = {}) => ({ dir: join(scratch, name), total, reserved: 0, gate: false, cap: undefined, waitMs: 0, ...more });

test("the pool is configured by both variables, and absent without either", () => {
    assert.deepEqual(poolOf({ TEST_SLOTS_DIR: "/ci-cache/test-slots", TEST_SLOTS: "16" }), {
        dir: "/ci-cache/test-slots",
        total: 16,
        reserved: 0,
        gate: false,
        cap: undefined,
        waitMs: 0,
    });
    assert.equal(poolOf({}), undefined);
    assert.equal(poolOf({ TEST_SLOTS_DIR: "/ci-cache/test-slots" }), undefined);
    assert.equal(poolOf({ TEST_SLOTS: "16" }), undefined);
    assert.equal(poolOf({ TEST_SLOTS_DIR: "", TEST_SLOTS: "16" }), undefined);
    assert.equal(poolOf({ TEST_SLOTS_DIR: "/x", TEST_SLOTS: "0" }), undefined);
    assert.equal(poolOf({ TEST_SLOTS_DIR: "/x", TEST_SLOTS: "lots" }), undefined);
});

test("a run takes what it wants while the pool has room, and three quarters of what is free at most", async () => {
    const pool = poolNamed("share", 16);
    const small = await acquireSlots(pool, 4);
    assert.equal(small.slots, 4);
    const greedy = await acquireSlots(pool, 100);
    // 12 free, of which 75% is 9.
    assert.equal(greedy.slots, 9);
    const late = await acquireSlots(pool, 100);
    assert.equal(late.slots, 3);
    const none = await acquireSlots(pool, 100);
    assert.equal(none.slots, 0);
    for (const held of [small, greedy, late, none]) {
        held.release();
    }
});

test("released slots go back to the pool", async () => {
    const pool = poolNamed("release", 4);
    const first = await acquireSlots(pool, 4);
    assert.equal(first.slots, 3);
    first.release();
    // The holder exits once its stdin closes; its locks go with it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await acquireSlots(pool, 4);
    assert.equal(second.slots, 3);
    second.release();
});

test("a holder that dies gives its slots back without being asked", async () => {
    const pool = poolNamed("death", 2);
    // Another process takes both slots and is then killed, as a cancelled job's would be.
    const script = `const { acquireSlots } = await import(${JSON.stringify(new URL("./test-memory-pool.mjs", import.meta.url).href)}); const held = await acquireSlots(${JSON.stringify(pool)}, 2); console.log(held.slots); setInterval(() => {}, 1000);`;
    const other = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const taken = await new Promise((resolve) => other.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    assert.equal(taken, 2);
    assert.equal((await acquireSlots(pool, 2)).slots, 0);
    other.kill("SIGKILL");
    await new Promise((resolve) => other.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const freed = await acquireSlots(pool, 2);
    assert.equal(freed.slots, 2);
    freed.release();
});

test("no pool, no want, or a directory nobody can write holds nothing and never throws", async () => {
    assert.equal((await acquireSlots(undefined, 4)).slots, 0);
    assert.equal((await acquireSlots(poolNamed("zero", 4), 0)).slots, 0);
    assert.equal((await acquireSlots({ dir: "/proc/no-such-pool", total: 4 }, 4)).slots, 0);
});

test("the reserved band, the priority, the cap and the wait are read from the job's variables", () => {
    const base = { TEST_SLOTS_DIR: "/x", TEST_SLOTS: "16" };
    assert.deepEqual(poolOf({ ...base, TEST_SLOTS_RESERVED: "6", TEST_SLOTS_PRIORITY: "gate", TEST_SLOTS_CAP: "6", TEST_SLOTS_WAIT: "90" }), {
        dir: "/x",
        total: 16,
        reserved: 6,
        gate: true,
        cap: 6,
        waitMs: 90_000,
    });
    // A band as large as the pool would leave an open run nothing to try; nonsense reads as unset.
    assert.equal(poolOf({ ...base, TEST_SLOTS_RESERVED: "40" })?.reserved, 15);
    assert.equal(poolOf({ ...base, TEST_SLOTS_RESERVED: "-2" })?.reserved, 0);
    assert.equal(poolOf({ ...base, TEST_SLOTS_CAP: "0" })?.cap, undefined);
    assert.equal(poolOf({ ...base, TEST_SLOTS_PRIORITY: "high" })?.gate, false);
    assert.equal(poolOf({ ...base, TEST_SLOTS_WAIT: "soon" })?.waitMs, 0);
});

test("a run that is not a gate never takes the reserved band, and a gate run takes it first", async () => {
    const dir = "reserved";
    const open = poolNamed(dir, 8, { reserved: 4 });
    const gate = poolNamed(dir, 8, { reserved: 4, gate: true });
    const holders = [];
    try {
        // 4 open slots, of which 75% is 3, then the last one.
        holders.push(await acquireSlots(open, 100));
        assert.equal(holders[0].slots, 3);
        holders.push(await acquireSlots(open, 100));
        assert.equal(holders[1].slots, 1);
        assert.equal((await acquireSlots(open, 100)).slots, 0);
        // Every open slot is held, so all the gate run gets is the band, untouched: three quarters of its four.
        holders.push(await acquireSlots(gate, 100));
        assert.equal(holders[2].slots, 3);
    } finally {
        for (const held of holders) {
            held.release();
        }
    }
});

test("a job's cap bounds what one run holds, however much is free", async () => {
    const held = await acquireSlots(poolNamed("cap", 16, { cap: 5 }), 100);
    assert.equal(held.slots, 5);
    held.release();
});

test("a run short of what it needs waits for room, keeps what it had, and stops at what it wanted", async () => {
    const pool = poolNamed("wait", 8, { waitMs: 5_000 });
    const hog = await acquireSlots(pool, 6);
    assert.equal(hog.slots, 6);
    setTimeout(() => hog.release(), 300);
    const started = Date.now();
    // 2 free at first, of which 75% rounds up to 2; the hog's 6 come back 300 ms in.
    const held = await acquireAtLeast(pool, 6, 4, { pollMs: 100 });
    assert.ok(held.slots >= 4, `held ${String(held.slots)}`);
    assert.ok(held.slots <= 6);
    assert.ok(held.waitedMs > 0);
    assert.ok(Date.now() - started < 4_000, "it stopped waiting once it had enough");
    held.release();
});

test("a wait runs out at the pool's limit and the run goes ahead with what it holds", async () => {
    const pool = poolNamed("timeout", 4, { waitMs: 400 });
    const hog = await acquireSlots(pool, 4);
    assert.equal(hog.slots, 3);
    const started = Date.now();
    const held = await acquireAtLeast(pool, 4, 4, { pollMs: 100 });
    const took = Date.now() - started;
    assert.equal(held.slots, 1);
    assert.ok(took >= 350 && took < 2_000, `waited ${String(took)} ms`);
    held.release();
    hog.release();
});

test("a run that needs nothing more, or has no wait, never waits", async () => {
    const quiet = await acquireAtLeast(poolNamed("nowait", 8, { waitMs: 5_000 }), 2, 0, { pollMs: 100 });
    assert.equal(quiet.slots, 2);
    assert.equal(quiet.waitedMs, 0);
    quiet.release();
    const pool = poolNamed("nolimit", 2, { waitMs: 0 });
    const hog = await acquireSlots(pool, 2);
    const started = Date.now();
    const short = await acquireAtLeast(pool, 2, 2, { pollMs: 100 });
    assert.ok(Date.now() - started < 300);
    short.release();
    hog.release();
});

test("a wait never asks for more than the job's cap allows", async () => {
    const pool = poolNamed("capwait", 16, { cap: 4, waitMs: 2_000 });
    const started = Date.now();
    // 9 wanted, 9 needed: the cap makes 4 the most it can ever hold, so 4 is enough and there is nothing to wait for.
    const held = await acquireAtLeast(pool, 9, 9, { pollMs: 100 });
    assert.equal(held.slots, 4);
    assert.ok(Date.now() - started < 1_000);
    held.release();
});
