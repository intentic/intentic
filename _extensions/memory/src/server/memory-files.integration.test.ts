import { mkdir, readFile, rm, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { deleteMemoryFile, listMemoryFiles, memoryRoot, readMemoryFile, writeMemoryFile } from "./memory-files.js";

const tempDirs: string[] = [];
// A fake workspace with .intentic/claude/projects/<project>/memory dirs, addressed through memoryRoot like the
// routes do.
const tempWorkspace = async (): Promise<{ root: string; seed: (project: string, name: string, content: string) => Promise<string> }> => {
    const workspace = await mkdtemp(join(tmpdir(), "intentic-memory-"));
    tempDirs.push(workspace);
    const root = memoryRoot(workspace);
    return {
        root,
        seed: async (project, name, content) => {
            const path = join(root, project, "memory", name);
            await mkdir(join(root, project, "memory"), { recursive: true });
            await writeFile(path, content);
            return path;
        },
    };
};
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

test("listMemoryFiles walks every project's memory dir newest-first and skips projects without one", async () => {
    const { root, seed } = await tempWorkspace();
    const older = await seed("-history-gits-root", "MEMORY.md", "index");
    await seed("-history-gits-root", "fact.md", "a fact");
    await mkdir(join(root, "-history-worktrees-abc"), { recursive: true });
    await utimes(older, new Date(1_000), new Date(1_000));
    const files = await listMemoryFiles(root);
    expect(files.map((file) => ({ project: file.project, name: file.name }))).toEqual([
        { project: "-history-gits-root", name: "fact.md" },
        { project: "-history-gits-root", name: "MEMORY.md" },
    ]);
    expect(files[1]?.sizeBytes).toBe(5);
});

test("listMemoryFiles returns empty for a missing projects root", async () => {
    const { root } = await tempWorkspace();
    expect(await listMemoryFiles(join(root, "absent"))).toEqual([]);
});

test("readMemoryFile returns content + stat and rejects escapes", async () => {
    const { root, seed } = await tempWorkspace();
    await seed("-p", "MEMORY.md", "hello");
    expect((await readMemoryFile(root, "-p", "MEMORY.md"))?.content).toBe("hello");
    expect(await readMemoryFile(root, "-p", "missing.md")).toBeUndefined();
    expect(await readMemoryFile(root, "-p", "../sessions/secret.jsonl")).toBeUndefined();
    expect(await readMemoryFile(root, "..", "memory/MEMORY.md")).toBeUndefined();
    expect(await readMemoryFile(root, "-p/memory", "../../other/memory/MEMORY.md")).toBeUndefined();
});

test("writeMemoryFile creates and updates .md files only, inside the memory dir only", async () => {
    const { root } = await tempWorkspace();
    expect(await writeMemoryFile(root, "-p", "new-fact.md", "fresh")).toBe(true);
    expect(await readFile(join(root, "-p", "memory", "new-fact.md"), "utf8")).toBe("fresh");
    expect(await writeMemoryFile(root, "-p", "new-fact.md", "edited")).toBe(true);
    expect(await readFile(join(root, "-p", "memory", "new-fact.md"), "utf8")).toBe("edited");
    expect(await writeMemoryFile(root, "-p", "script.sh", "nope")).toBe(false);
    expect(await writeMemoryFile(root, "-p", "../settings.md", "nope")).toBe(false);
});

test("deleteMemoryFile removes a note and refuses directories and escapes", async () => {
    const { root, seed } = await tempWorkspace();
    await seed("-p", "fact.md", "gone soon");
    expect(await deleteMemoryFile(root, "-p", "fact.md")).toBe(true);
    await expect(readFile(join(root, "-p", "memory", "fact.md"))).rejects.toThrow();
    expect(await deleteMemoryFile(root, "-p", "fact.md")).toBe(false);
    expect(await deleteMemoryFile(root, "-p", ".")).toBe(false);
    expect(await deleteMemoryFile(root, "-p", "../memory")).toBe(false);
});
