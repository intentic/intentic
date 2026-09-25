// Pins the ceiling a test process is held under: read from the environment with a default, measured as resident plus
// swapped memory over the whole process tree, and the first process past it named.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ceilingBytes, DEFAULT_CEILING_BYTES, heldBytes, overCeiling, processTree } from "./memory-ceiling.mjs";

const MIB = 1024 ** 2;

// A /proc with the given processes: pid -> [ppid, rss kB, swap kB], comm deliberately holding a ") " to parse past.
const fakeProc = (processes) => {
    const root = mkdtempSync(join(tmpdir(), "fake-proc-"));
    for (const [pid, [ppid, rss, swap]] of Object.entries(processes)) {
        mkdirSync(join(root, pid));
        writeFileSync(join(root, pid, "stat"), `${pid} (bun (worker) x) S ${ppid} ${pid} 1 0 -1\n`);
        writeFileSync(join(root, pid, "status"), `Name:\tbun\nVmRSS:\t${rss} kB\nVmSwap:\t${swap} kB\n`);
    }
    mkdirSync(join(root, "self"));
    return root;
};

test("the ceiling is 6 GiB unless the environment names one, and 0 turns it off", () => {
    assert.equal(ceilingBytes({}), DEFAULT_CEILING_BYTES);
    assert.equal(ceilingBytes({ TEST_MEMORY_CEILING_MB: "1024" }), 1024 * MIB);
    assert.equal(ceilingBytes({ TEST_MEMORY_CEILING_MB: "0" }), 0);
    assert.equal(ceilingBytes({ TEST_MEMORY_CEILING_MB: "lots" }), DEFAULT_CEILING_BYTES);
});

test("the tree is the root and everything below it, and nothing beside it", () => {
    const proc = fakeProc({ 10: [1, 100, 0], 11: [10, 100, 0], 12: [11, 100, 0], 20: [1, 100, 0] });
    assert.deepEqual(processTree(10, proc).toSorted(), [10, 11, 12]);
});

test("a process holds its resident and its swapped memory together", () => {
    const proc = fakeProc({ 10: [1, 1024, 2048] });
    assert.equal(heldBytes(10, proc), 3 * MIB);
    assert.equal(heldBytes(99, proc), 0);
});

test("the first process past the ceiling is named, a worker deep in the tree included", () => {
    const proc = fakeProc({ 10: [1, 50 * 1024, 0], 11: [10, 2 * 1024, 0], 12: [11, 7000 * 1024, 900 * 1024] });
    assert.deepEqual(overCeiling(10, 6000 * MIB, proc), { pid: 12, held: 7900 * MIB });
    assert.equal(overCeiling(10, 8000 * MIB, proc), undefined);
});
