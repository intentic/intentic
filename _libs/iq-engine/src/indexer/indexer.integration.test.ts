import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openIndex, type IndexDb } from "../store/db.js";
import { listFiles } from "../store/index-store.js";
import { makeFixtureWorkspace } from "../testing.js";
import { sweep } from "../workspace/scan.js";
import { indexLag, revalidate } from "./indexer.js";

let root: string;
let cleanup: () => Promise<void>;
let indexDir: string;
let db: IndexDb;

beforeAll(async () => {
    ({ root, cleanup } = await makeFixtureWorkspace());
    indexDir = await mkdtemp(join(tmpdir(), "iq-index-"));
    db = openIndex(indexDir, "write");
});
afterAll(async () => {
    db.close();
    await rm(indexDir, { recursive: true, force: true });
    await cleanup();
});

test("revalidate: initial build, touch-only skip, content change, delete", async () => {
    const first = await revalidate(db, await sweep(root, false));
    expect(first.changed).toBeGreaterThan(0);
    expect(listFiles(db).has("alpha/src/widget.ts")).toBe(true);

    // No changes → same generation.
    const second = await revalidate(db, await sweep(root, false));
    expect(second.changed).toBe(0);
    expect(second.generation).toBe(first.generation);

    // Touch (mtime bump, same content) → hash confirms, no generation bump.
    const widget = join(root, "alpha/src/widget.ts");
    await utimes(widget, new Date(), new Date(Date.now() + 5000));
    const touched = await revalidate(db, await sweep(root, false));
    expect(touched.generation).toBe(first.generation);

    // Content change → generation bumps, hash updates.
    const before = listFiles(db).get("alpha/src/widget.ts")!.hash;
    await writeFile(widget, "export const createWidget = (name: string): { name: string } => ({ name });\n");
    const changed = await revalidate(db, await sweep(root, false));
    expect(changed.generation).toBeGreaterThan(first.generation);
    expect(listFiles(db).get("alpha/src/widget.ts")!.hash).not.toBe(before);

    // Delete → row cascades away.
    await rm(join(root, "notes.md"));
    await revalidate(db, await sweep(root, false));
    expect(listFiles(db).has("notes.md")).toBe(false);
});

// One index serves every agent worktree of a repo, and `git worktree add` stamps a fresh mtime on every file it
// checks out. The reported lag has to survive that, or every answer in a worktree opens with a false alarm.
test("indexLag: a checkout's fresh mtimes are not lag; a real edit and a new file are", async () => {
    await revalidate(db, await sweep(root, false));
    expect(indexLag(db, await sweep(root, false))).toBe(0);

    // The worktree signature: every mtime moved, no content did.
    const future = new Date(Date.now() + 60_000);
    for (const entry of await sweep(root, false)) {
        await utimes(entry.abs, future, future);
    }
    expect(indexLag(db, await sweep(root, false))).toBe(0);

    await writeFile(join(root, "alpha/src/widget.ts"), `export const createWidget = (): string => \`grown\`;\n${"// filler\n".repeat(20)}`);
    await writeFile(join(root, "alpha/src/fresh.ts"), "export const fresh = 1;\n");
    expect(indexLag(db, await sweep(root, false))).toBe(2);

    await revalidate(db, await sweep(root, false));
    await rm(join(root, "alpha/src/fresh.ts"));
    expect(indexLag(db, await sweep(root, false))).toBe(1);
    await revalidate(db, await sweep(root, false));
});

test("binary files get a bare marker row, not derived data", async () => {
    await writeFile(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]));
    await revalidate(db, await sweep(root, false));
    const row = listFiles(db).get("blob.bin");
    expect(row?.hash).toBe("-");
    // A second pass must not re-read it (mtime+size short-circuit → no generation bump).
    const generation = (await revalidate(db, await sweep(root, false))).generation;
    expect((await revalidate(db, await sweep(root, false))).generation).toBe(generation);
});
