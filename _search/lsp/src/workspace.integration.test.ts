import { mkdirSync, mkdtempSync } from "node:fs";
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
    expect(workspace.diagnose([join(dir, "ok.ts")])).toEqual({ diagnostics: [], unavailable: [] });
    const report = workspace.diagnose([join(dir, "bad.ts")]);
    expect(report.diagnostics.map((d) => d.code)).toContain(2322);
    expect(report.unavailable).toEqual([]);
});

test("results are cached by version — a second ask without an edit reuses them", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const workspace = new Workspace();
    workspace.diagnose([file]);
    expect(workspace.fresh(file)).toEqual({ diagnostics: [] });
});

test("touched invalidates the cache, and the re-check sees the new content", async () => {
    const dir = await scaffold({ "a.ts": "export const n: number = 1;\n" });
    const file = join(dir, "a.ts");
    const workspace = new Workspace();
    expect(workspace.diagnose([file]).diagnostics).toEqual([]);

    await writeFile(file, "export const n: number = 'now broken';\n");
    // Without the signal the warm program is entitled to keep serving its cached snapshot.
    expect(workspace.fresh(file)).toEqual({ diagnostics: [] });
    workspace.touched([file]);
    expect(workspace.fresh(file)).toBeUndefined();
    expect(workspace.diagnose([file]).diagnostics.map((d) => d.code)).toContain(2322);
});

test("an edit in one file surfaces the break it causes in another that imports it", async () => {
    const dir = await scaffold({
        "a.ts": "export const value = 1;\n",
        "b.ts": "import { value } from './a.js';\nexport const doubled: number = value * 2;\n",
    });
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    const workspace = new Workspace();
    expect(workspace.diagnose([b]).diagnostics).toEqual([]);

    await writeFile(a, "export const value = 'text';\n");
    workspace.touched([a]);
    // b was never touched, so a cache keyed on b's own version would keep serving the clean answer forever.
    // Catching this is the whole point of keying markers on a workspace generation instead.
    expect(workspace.diagnose([b]).diagnostics.length).toBeGreaterThan(0);
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
    const report = workspace.fresh(file);
    expect(report !== undefined && "diagnostics" in report && report.diagnostics.map((d) => d.code)).toContain(2322);
});

test("a file belonging to no project is refused, not reported clean", () => {
    const report = new Workspace().diagnose(["/nonexistent/nowhere.ts"]);
    expect(report.diagnostics).toEqual([]);
    expect(report.unavailable).toHaveLength(1);
});

/* THE REGRESSION THAT MOTIVATED REFUSAL. A tsconfig whose `extends` target cannot be resolved — a worktree
 * whose node_modules live in a mount namespace the daemon cannot see — used to fall back to default options
 * (ES5, no lib, no types) and report Map, Promise and `node:` imports as broken in perfectly healthy code:
 * ~74% of every diagnostic the hook injected over a week. The only honest answer is a refusal naming the
 * reason. */
test("a config whose extends cannot be resolved refuses instead of reporting ES5 phantoms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-ws-broken-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ extends: "@nowhere/tsconfig.base.json", include: ["*.ts"] }));
    const file = join(dir, "healthy.ts");
    // Healthy modern code that an ES5-defaulted program reports as broken (TS2583 Map, TS2550 replaceAll).
    await writeFile(file, 'export const seen = new Map<string, number>();\nexport const clean = "a-b".replaceAll("-", "_");\n');

    const report = new Workspace().diagnose([file]);
    expect(report.diagnostics).toEqual([]);
    expect(report.unavailable).toHaveLength(1);
    expect(report.unavailable[0]?.reason).toContain("not found");
});

test("a refused project heals on the next ask once its extends target appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-ws-heal-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./base/tsconfig.base.json", include: ["*.ts"] }));
    const file = join(dir, "a.ts");
    await writeFile(file, "export const n: number = 'no';\n");

    const workspace = new Workspace();
    expect(workspace.diagnose([file]).unavailable).toHaveLength(1);

    // The install lands: the extends target exists now. The broken project was deliberately not cached, so the
    // next touched ask re-parses the config and answers for real — with the file's genuine error, not phantoms.
    mkdirSync(join(dir, "base"));
    await writeFile(
        join(dir, "base", "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, types: [] } }),
    );
    workspace.touched([file]);
    const healed = workspace.diagnose([file]);
    expect(healed.unavailable).toEqual([]);
    expect(healed.diagnostics.map((d) => d.code)).toContain(2322);
});
