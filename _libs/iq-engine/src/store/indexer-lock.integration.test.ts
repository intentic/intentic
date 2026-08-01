import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openIndex } from "./db.js";
import { claimIndexer, indexerAlive, releaseIndexer } from "./indexer-lock.js";

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "iq-lock-"));
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("an unclaimed index is unowned, and a claim by THIS process still reads as unowned to itself", () => {
    expect(indexerAlive(dir)).toBe(false);
    claimIndexer(dir);
    // The owner must keep writing through its own lock — otherwise the daemon would stop indexing the moment it
    // claimed the index.
    expect(indexerAlive(dir)).toBe(false);
    releaseIndexer(dir);
    expect(indexerAlive(dir)).toBe(false);
});

test("a live foreign pid owns the index; a dead or unparseable one does not", async () => {
    // pid 1 exists in every process namespace this can run in, so it stands in for a live daemon.
    await writeFile(join(dir, "indexer.pid"), "1");
    expect(indexerAlive(dir)).toBe(true);

    // A daemon killed mid-pass (SIGKILL, a sandbox rebuild) leaves its pid behind. The OS answers that it is
    // gone, so the next one-shot engine takes over indexing rather than refusing to write forever.
    await writeFile(join(dir, "indexer.pid"), "4194304");
    expect(indexerAlive(dir)).toBe(false);

    await writeFile(join(dir, "indexer.pid"), "");
    expect(indexerAlive(dir)).toBe(false);
    releaseIndexer(dir);
});

test("a read-mode handle cannot write, so a non-owner can never take the write lock", async () => {
    const writer = openIndex(dir, "write");
    writer.run("INSERT INTO meta (key, value) VALUES ('probe', 'x')");
    const reader = openIndex(dir, "read");
    expect(reader.get("SELECT value FROM meta WHERE key = 'probe'")?.["value"]).toBe("x");
    expect(() => reader.run("INSERT INTO meta (key, value) VALUES ('nope', 'y')")).toThrow(/readonly/i);
    reader.close();
    writer.close();
});
