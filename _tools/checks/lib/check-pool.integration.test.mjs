import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPool, editLane, pooledMap } from "./check-pool.mjs";
import { CHECKS } from "../manifest.mjs";

test("bounded work preserves input order across out-of-order completion", async () => {
    const release = [];
    const begun = [];
    const reading = pooledMap([0, 1, 2], 2, async (value) => {
        begun.push(value);
        await new Promise((resolve) => { release[value] = resolve; });
        return value * 2;
    });
    assert.deepEqual(begun, [0, 1]);
    release[1]();
    await new Promise(setImmediate);
    assert.deepEqual(begun, [0, 1, 2]);
    release[2]();
    release[0]();
    assert.deepEqual(await reading, [0, 2, 4]);
});

test("separate invocations contend on the same kernel slot", { skip: process.platform !== "linux" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "check-pool-test-"));
    const env = { ...process.env, INTENTIC_QUEUE_DIR: dir };
    const first = checkPool(env);
    const second = checkPool(env);
    const launch = (pool) => {
        const script = "const fs = require('node:fs'); const marker = process.argv[1]; fs.closeSync(fs.openSync(marker, 'wx')); process.stdout.write('held\\n'); process.stdin.resume(); process.stdin.on('end', () => { fs.unlinkSync(marker); process.exit(0); });";
        const [file, args] = pool.command(0, process.execPath, ["-e", script, join(dir, "active")]);
        const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
        const held = new Promise((resolve, reject) => {
            child.stdout.once("data", resolve);
            child.once("error", reject);
            child.once("exit", (code) => { if (code !== 0) {reject(new Error(`slot child exited ${code}`));} });
        });
        const ended = new Promise((resolve) => child.once("exit", resolve));
        return { child, held, ended };
    };
    const a = launch(first);
    const b = launch(second);
    try {
        const winner = await Promise.race([a.held.then(() => a), b.held.then(() => b)]);
        const loser = winner === a ? b : a;
        // The child atomically creates `active`; overlap makes the other fail instead of passing on timing alone.
        winner.child.stdin.end();
        assert.equal(await winner.ended, 0);
        await loser.held;
        loser.child.stdin.end();
        assert.equal(await loser.ended, 0);
    } finally {
        a.child.stdin.end(); b.child.stdin.end();
        await Promise.all([a.ended, b.ended]);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an edit lane waits for other edit lanes only, never for a whole-tree run's slots", { skip: process.platform !== "linux" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "check-pool-test-"));
    const env = { ...process.env, INTENTIC_QUEUE_DIR: dir };
    const pool = checkPool(env);
    // Every whole-tree slot held, as a turn's full run holds them.
    const holders = Array.from({ length: pool.size }, (_, slot) => {
        const [file, args] = pool.command(slot, "sh", ["-c", "echo held; exec cat >/dev/null"]);
        const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
        return { child, held: new Promise((resolve) => child.stdout.once("data", resolve)), ended: new Promise((resolve) => child.once("exit", resolve)) };
    });
    const lanes = [];
    try {
        await Promise.all(holders.map(({ held }) => held));
        for (let lane = 0; lane < pool.size; lane++) {
            lanes.push(await editLane(env));
        }
        // The lane is full: one more waits until an edit gives its slot back, whichever slot that is.
        let taken = false;
        const waiting = editLane(env).then((release) => {
            taken = true;
            return release;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(taken, false);
        lanes.pop()();
        lanes.push(await waiting);
        assert.equal(taken, true);
    } finally {
        for (const release of lanes) {
            release();
        }
        for (const { child } of holders) {
            child.stdin.end();
        }
        await Promise.all(holders.map(({ ended }) => ended));
        rmSync(dir, { recursive: true, force: true });
    }
});

test("applicability retains mixed file coverage and leaves unknown checks eligible", () => {
    const applicable = (id, paths) => { const check = CHECKS.find((entry) => entry.id === id); return check.applies === undefined || paths.some((path) => check.applies.test(path)); };
    assert.equal(applicable("buttons", ["server.ts"]), false);
    assert.equal(applicable("buttons", ["server.ts", "Dialog.vue"]), true);
    assert.equal(applicable("extension-deps", ["_extensions/foo/src/index.ts"]), true);
    assert.equal(applicable("extension-deps", ["_extensions/foo/package.json"]), true);
    assert.equal(applicable("i18n-keys", ["src/locales/en.json"]), true);
    assert.equal(applicable("control-chars", ["notes.md"]), true);
});
