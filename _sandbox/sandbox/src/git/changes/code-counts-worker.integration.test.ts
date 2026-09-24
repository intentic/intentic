import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LineStat } from "@intentic/code-read";
import { siblingModule, workerCalls } from "../../workers/worker-calls.js";
import type { CodeCountAsk, CodeCountThread } from "./code-counts.js";

// The counting thread against a real grammar and a real cache file: what one thread counted, the next reads back
// instead of tokenizing again, and only for the same two texts.

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const cacheIn = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-code-count-cache-"));
    tempDirs.push(dir);
    return join(dir, "code-counts.db");
};

// One thread's lifetime, as a restart bounds it: started, asked, closed.
const countOnce = async (thread: CodeCountThread, ask: CodeCountAsk): Promise<LineStat | undefined> => {
    const calls = workerCalls<CodeCountAsk>(siblingModule(import.meta, "code-counts-worker"), thread);
    try {
        return await calls.call<LineStat | undefined>(ask);
    } finally {
        await calls.close();
    }
};

const edit: CodeCountAsk = { path: "a.ts", before: "const a = 1;\n", after: "// why\nconst a = 1;\nconst b = 2;\n" };

test("a count one thread made is read back by the next, and never taken for different text", async () => {
    const cachePath = await cacheIn();
    expect(await countOnce({ cachePath }, edit)).toEqual({ additions: 1, deletions: 0 });

    // Rewritten behind the thread's back: a number no tokenizer would produce proves the next answer came off disk.
    const db = new DatabaseSync(cachePath);
    expect(db.prepare("UPDATE counts SET additions = 99").run().changes).toBe(1);
    db.close();

    expect(await countOnce({ cachePath }, edit)).toEqual({ additions: 99, deletions: 0 });
    expect(await countOnce({ cachePath }, { ...edit, after: `${edit.after}const c = 3;\n` })).toEqual({ additions: 2, deletions: 0 });
});

// Past lineStat's table budget: every line of each side differs, so there is no common head or tail to trim.
const apart: CodeCountAsk = {
    path: "a.ts",
    before: Array.from({ length: 1100 }, (_, line) => `const a${String(line)} = ${String(line)};`).join("\n"),
    after: Array.from({ length: 1100 }, (_, line) => `const b${String(line)} = ${String(line)};`).join("\n"),
};

test("a pair too far apart to diff is kept on disk as such, not tokenized again by the next thread", async () => {
    const cachePath = await cacheIn();
    expect(await countOnce({ cachePath }, apart)).toBeUndefined();
    const db = new DatabaseSync(cachePath);
    expect(db.prepare("SELECT additions, deletions FROM counts").all()).toEqual([{ additions: null, deletions: null }]);
    // Planted numbers the next thread can only have read off disk.
    db.prepare("UPDATE counts SET additions = 5, deletions = 6").run();
    db.close();
    expect(await countOnce({ cachePath }, apart)).toEqual({ additions: 5, deletions: 6 });
});

test("a thread with nowhere to keep counts still counts", async () => {
    expect(await countOnce({}, edit)).toEqual({ additions: 1, deletions: 0 });
});
