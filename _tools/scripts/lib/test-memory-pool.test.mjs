// Pins the pool's three promises: a run takes its share of what is free and no more, what one run holds the next cannot
// take until it is released, and nothing about a missing or broken pool ever stops a run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireSlots, poolOf } from "./test-memory-pool.mjs";

const scratch = mkdtempSync(join(tmpdir(), "test-memory-pool-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const poolNamed = (name, total) => ({ dir: join(scratch, name), total });

test("the pool is configured by both variables, and absent without either", () => {
    assert.deepEqual(poolOf({ TEST_SLOTS_DIR: "/ci-cache/test-slots", TEST_SLOTS: "16" }), { dir: "/ci-cache/test-slots", total: 16 });
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
