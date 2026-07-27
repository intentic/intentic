import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Workspace } from "./workspace.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-ws-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: [] },
            include: ["*.ts"],
        }),
    );
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content);
    }
    return dir;
};

test("a clean file reports nothing and a broken one reports its error", async () => {
    const dir = await scaffold({ "ok.ts": "export const n: number = 1;\n", "bad.ts": "export const n: number = 'no';\n" });
    const workspace = new Workspace();
    expect(workspace.diagnose([join(dir, "ok.ts")])).toEqual([]);
    const errors = workspace.diagnose([join(dir, "bad.ts")]);
    expect(errors.map((d) => d.code)).toContain(2322);
});

test("results are cached by version — a second ask without an edit reuses them", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const workspace = new Workspace();
    workspace.diagnose([file]);
    expect(workspace.fresh(file)).toEqual([]);
});

test("touched invalidates the cache, and the re-check sees the new content", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const workspace = new Workspace();
    expect(workspace.diagnose([file])).toEqual([]);

    await writeFile(file, "export const n: number = 'now broken';\n");
    // Without the signal the warm program is entitled to keep serving its cached snapshot.
    expect(workspace.fresh(file)).toEqual([]);
    workspace.touched([file]);
    expect(workspace.fresh(file)).toBeUndefined();
    expect(workspace.diagnose([file]).map((d) => d.code)).toContain(2322);
});

test("an edit in one file surfaces the break it causes in another that imports it", async () => {
    const dir = await scaffold({
        "a.ts": "export const value = 1;\n",
        "b.ts": "import { value } from './a.js';\nexport const doubled: number = value * 2;\n",
    });
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    const workspace = new Workspace();
    expect(workspace.diagnose([b])).toEqual([]);

    await writeFile(a, "export const value = 'text';\n");
    workspace.touched([a]);
    // b was never touched, so a cache keyed on b's own version would keep serving the clean answer forever.
    // Catching this is the whole point of keying markers on a workspace generation instead.
    expect(workspace.diagnose([b]).length).toBeGreaterThan(0);
});

test("refresh brings every open file current, so a later read is a map lookup", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const workspace = new Workspace();
    workspace.diagnose([file]);

    await writeFile(file, "export const n: number = 'no';\n");
    workspace.touched([file]);
    expect(workspace.fresh(file)).toBeUndefined();
    workspace.refresh();
    expect(workspace.fresh(file)?.map((d) => d.code)).toContain(2322);
});

test("a file belonging to no project still answers instead of throwing", () => {
    const workspace = new Workspace();
    expect(() => workspace.diagnose(["/nonexistent/nowhere.ts"])).not.toThrow();
});
