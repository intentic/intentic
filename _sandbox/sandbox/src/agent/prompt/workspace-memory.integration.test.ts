import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_FILE } from "@intentic/constants";
import { afterEach, expect, test } from "vitest";
import { workspaceMemoryNote } from "./workspace-memory.js";

// The properties a runtime's own discovery got wrong: the root file reaches a turn that starts somewhere else, a nested
// folder's file adds to it rather than replacing it, and nothing below the start folder is read.

const dirs: string[] = [];

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "workspace-memory-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("a turn starting in a nested repo is told the workspace's rules and that repo's, in that order", async () => {
    const root = await scaffold({
        [MEMORY_FILE]: "No legacy support.",
        [`shop/${MEMORY_FILE}`]: "Prices are integers, in cents.",
        [`shop/.git/HEAD`]: "ref: refs/heads/main\n",
        // Below the start folder, so it belongs to work the turn hasn't reached: never read.
        [`shop/checkout/${MEMORY_FILE}`]: "Never log a card number.",
    });

    const note = workspaceMemoryNote({ root, cwd: join(root, "shop") });

    expect(note).toContain("No legacy support.");
    expect(note).toContain("Prices are integers, in cents.");
    expect(note).not.toContain("Never log a card number.");
    // Root first: the workspace's own rules are the frame the nested repo's are read inside.
    expect(note?.indexOf("No legacy support.")).toBeLessThan(note?.indexOf("Prices are integers, in cents.") ?? -1);
    // Labelled by the path the agent would open, not the daemon's temp dir.
    expect(note).toContain(`### shop/${MEMORY_FILE}`);
});

test("a start folder outside the workspace gets the workspace's own rules, not nothing", async () => {
    const root = await scaffold({ [MEMORY_FILE]: "Ask before deleting anything." });

    expect(workspaceMemoryNote({ root, cwd: join(root, "..") })).toContain("Ask before deleting anything.");
});

test("a workspace with no memory file says nothing at all", async () => {
    const root = await scaffold({ "README.md": "# Shop" });

    expect(workspaceMemoryNote({ root, cwd: root })).toBeUndefined();
});

test("an empty memory file is nothing to say, not an empty heading", async () => {
    const root = await scaffold({ [MEMORY_FILE]: "\n  \n" });

    expect(workspaceMemoryNote({ root, cwd: root })).toBeUndefined();
});

test("a file over the budget is dropped whole and named, never the workspace's own", async () => {
    const root = await scaffold({
        [MEMORY_FILE]: "Keep it short.",
        [`shop/${MEMORY_FILE}`]: "x".repeat(20_001),
    });

    const note = workspaceMemoryNote({ root, cwd: join(root, "shop") });

    expect(note).toContain("Keep it short.");
    expect(note).not.toContain("x".repeat(100));
    expect(note).toContain(`Too long to include here, read them yourself if the work goes near them: shop/${MEMORY_FILE}.`);
});
