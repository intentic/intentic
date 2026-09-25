import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceTrash, freeRestoreTarget, TRASH_RETENTION_MS, TrashMissError } from "./workspace-trash.js";

const scratch = async (): Promise<{ root: string; trashDir: string }> => {
    const root = await mkdtemp(join(tmpdir(), "trash-"));
    return { root, trashDir: join(root, ".intentic", "local", "trash") };
};

test("a trashed file comes back to its own path, recreating the folders that went since", async () => {
    const { root, trashDir } = await scratch();
    const trash = createWorkspaceTrash(trashDir);
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "note.md"), "hello");

    const id = await trash.put(join(root, "a"), "a");
    expect(await readdir(root)).toEqual([".intentic"]);

    const landed = await trash.restore(id ?? "", async (rel) => join(root, rel));
    expect(landed).toBe(join(root, "a"));
    expect(await readFile(join(root, "a", "b", "note.md"), "utf8")).toBe("hello");
    // The slot goes with the restore.
    expect(await readdir(trashDir)).toEqual([]);
    await expect(trash.restore(id ?? "", async (rel) => join(root, rel))).rejects.toBeInstanceOf(TrashMissError);
});

test("a taken name restores beside itself, keeping a file's extension last", async () => {
    const { root } = await scratch();
    await writeFile(join(root, "report.pdf"), "");
    expect(await freeRestoreTarget(join(root, "report.pdf"), false)).toBe(join(root, "report (restored).pdf"));
    await writeFile(join(root, "report (restored).pdf"), "");
    expect(await freeRestoreTarget(join(root, "report.pdf"), false)).toBe(join(root, "report (restored 2).pdf"));
    await writeFile(join(root, ".env"), "");
    expect(await freeRestoreTarget(join(root, ".env"), false)).toBe(join(root, ".env (restored)"));
    await mkdir(join(root, "v1.2"));
    expect(await freeRestoreTarget(join(root, "v1.2"), true)).toBe(join(root, "v1.2 (restored)"));
    expect(await freeRestoreTarget(join(root, "free.txt"), false)).toBe(join(root, "free.txt"));
});

test("nothing at the path trashes nothing, and the sweep drops only what outlived the retention", async () => {
    const { root, trashDir } = await scratch();
    const trash = createWorkspaceTrash(trashDir);
    expect(await trash.put(join(root, "ghost"), "ghost")).toBeUndefined();

    await writeFile(join(root, "old.txt"), "");
    await writeFile(join(root, "new.txt"), "");
    const old = await trash.put(join(root, "old.txt"), "old.txt");
    const fresh = await trash.put(join(root, "new.txt"), "new.txt");
    const past = new Date(Date.now() - TRASH_RETENTION_MS - 60_000);
    await utimes(join(trashDir, old ?? ""), past, past);

    await trash.sweep(Date.now());
    expect(await readdir(trashDir)).toEqual([fresh ?? ""]);
});
