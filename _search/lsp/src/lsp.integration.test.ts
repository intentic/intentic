import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { diagnose } from "./diag.js";
import { findTsconfig, openProject, unusableReason } from "./project.js";
import { rename } from "./rename.js";

// A throwaway TS project on disk: a minimal nodenext tsconfig plus the given flat files. Returns the dir so the
// test can read the rewritten files back.
const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-"));
    // A package.json bounds nodenext's package-scope walk to this dir (declaring the files ESM), and `types: []`
    // stops typeRoots from scanning ambient node_modules/@types up the tmpdir tree — keeping resolution hermetic.
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

test("rename updates the declaration and every usage across files in the project", async () => {
    const dir = await scaffold({
        "a.ts": "export const oldName = 1;\n",
        "b.ts": "import { oldName } from './a.js';\nexport const doubled = oldName * 2;\n",
    });
    const target = join(dir, "a.ts");
    const result = rename(openProject(findTsconfig(target), target), target, "oldName", "newName");
    expect(result.changedFiles.length).toBe(2);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toContain("export const newName = 1;");
    const b = await readFile(join(dir, "b.ts"), "utf8");
    expect(b).toContain("import { newName }");
    expect(b).toContain("newName * 2");
    expect(b).not.toContain("oldName");
});

test("rename throws when the symbol isn't declared in the file", async () => {
    const dir = await scaffold({ "a.ts": "export const present = 1;\n" });
    const target = join(dir, "a.ts");
    expect(() => rename(openProject(findTsconfig(target), target), target, "absent", "x")).toThrow(/no declaration named "absent"/);
});

test("diag reports a semantic error", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 'not a number';\n" });
    const target = join(dir, "a.ts");
    const diagnostics = diagnose(openProject(findTsconfig(target), target), [target]);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.category).toBe("error");
    expect(diagnostics[0]?.message).toMatch(/not assignable/);
});

test("diag returns nothing for a clean file", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 42;\n" });
    const target = join(dir, "a.ts");
    expect(diagnose(openProject(findTsconfig(target), target), [target])).toEqual([]);
});

test("a healthy project is usable — the canary the broken week would have tripped on day one", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 42;\n" });
    const target = join(dir, "a.ts");
    expect(unusableReason(openProject(findTsconfig(target), target))).toBeUndefined();
});

test("an unresolvable extends marks the project unusable, with the reason naming the config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-broken-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ extends: "@nowhere/tsconfig.base.json", include: ["*.ts"] }));
    const target = join(dir, "a.ts");
    await writeFile(target, "export const seen = new Map<string, number>();\n");
    const reason = unusableReason(openProject(findTsconfig(target), target));
    expect(reason).toContain("tsconfig.json");
    expect(reason).toContain("not found");
});

test("a types entry with no type definitions behind it marks the project unusable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-notypes-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: ["node"], strict: true }, include: ["*.ts"] }));
    const target = join(dir, "a.ts");
    await writeFile(target, "export const n = 1;\n");
    expect(unusableReason(openProject(findTsconfig(target), target))).toContain("node");
});

// The plain TS service cannot resolve SFC imports — that is vue-tsc's job — so without the shim every .vue
// import in a healthy file reported TS2307, permanently. Through the shim the import lands as `any`: unchecked
// here rather than falsely broken, while the file's real diagnostics still surface.
test("a .vue import resolves through the shim instead of reporting TS2307", async () => {
    const dir = await scaffold({
        "App.vue": "<template><div/></template>",
        "main.ts": "import App from './App.vue';\nexport const app = App;\nexport const bad: number = 'no';\n",
    });
    const target = join(dir, "main.ts");
    const codes = diagnose(openProject(findTsconfig(target), target), [target]).map((d) => d.code);
    expect(codes).not.toContain(2307);
    expect(codes).toContain(2322);
});
