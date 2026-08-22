import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { listLogFiles, pruneLogFiles, tailLogFile } from "./log-files.js";

const tempDirs: string[] = [];
const tempRoot = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-logs-"));
    tempDirs.push(dir);
    return dir;
};
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("listLogFiles walks nested files newest-first with root-relative posix names", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "terminals"), { recursive: true });
    await writeFile(join(root, "daemon.log"), "d");
    await writeFile(join(root, "terminals", "web-1-%0.log"), "t");
    await utimes(join(root, "daemon.log"), new Date(1_000), new Date(1_000));
    const files = await listLogFiles(root);
    expect(files.map((file) => file.name)).toEqual(["terminals/web-1-%0.log", "daemon.log"]);
    expect(files[1]?.sizeBytes).toBe(1);
});

test("listLogFiles returns empty for a missing root", async () => {
    expect(await listLogFiles(join(await tempRoot(), "absent"))).toEqual([]);
});

test("tailLogFile returns the newest bytes and rejects escapes", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "daemon.log"), "0123456789");
    expect(await tailLogFile(root, "daemon.log", 4)).toEqual({ sizeBytes: 10, text: "6789" });
    expect(await tailLogFile(root, "daemon.log", 100)).toEqual({ sizeBytes: 10, text: "0123456789" });
    expect(await tailLogFile(root, "missing.log", 4)).toBeUndefined();
    expect(await tailLogFile(root, "../escape", 4)).toBeUndefined();
});

test("pruneLogFiles truncates oversized files to their tail and drops stale ones", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "big.log"), Buffer.alloc(5_000_001, 120));
    await writeFile(join(root, "stale.log"), "old");
    await utimes(join(root, "stale.log"), new Date(0), new Date(0));
    await writeFile(join(root, "fresh.log"), "new");
    await pruneLogFiles(root);
    expect((await stat(join(root, "big.log"))).size).toBe(1_000_000);
    await expect(readFile(join(root, "stale.log"))).rejects.toThrow();
    expect((await readFile(join(root, "fresh.log"), "utf8")).toString()).toBe("new");
});

/* THE RESOURCE SERIES GETS ITS OWN CAP, because 5MB of it is about 21 hours.
 *
 * It writes one ~4KB object a minute, so the shared debug-log ceiling meant the file could not answer "what did
 * memory do yesterday" no matter who asked. That is the same failure as not recording it at all. */
test("resource-metrics.jsonl keeps a week where a debug log keeps 5MB", async () => {
    const root = await tempRoot();
    // Six megabytes: past the shared cap, nowhere near this file's own.
    await writeFile(join(root, "resource-metrics.jsonl"), Buffer.alloc(6_000_000, 120));
    await writeFile(join(root, "daemon.log"), Buffer.alloc(6_000_000, 120));
    await pruneLogFiles(root);

    // Untouched: it is well inside its 40MB budget.
    expect((await stat(join(root, "resource-metrics.jsonl"))).size).toBe(6_000_000);
    // The ordinary log is still held to the shared cap, so the exception is an exception.
    expect((await stat(join(root, "daemon.log"))).size).toBe(1_000_000);
});

test("past its own cap the series is truncated to a tail that still holds most of the week", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "resource-metrics.jsonl"), Buffer.alloc(40_000_001, 120));
    await pruneLogFiles(root);
    expect((await stat(join(root, "resource-metrics.jsonl"))).size).toBe(30_000_000);
});
