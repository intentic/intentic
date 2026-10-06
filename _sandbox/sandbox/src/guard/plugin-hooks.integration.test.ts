import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pluginHooks } from "./plugin-hooks.js";

// What a hooks module could load, as the approval pins it: every code file under the plugin, wherever it lives.

const write = (path: string, text: string): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
};

const pluginWith = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-hooks-"));
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "0.1.0" }));
    write(join(dir, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.ts"] }));
    for (const [name, text] of Object.entries(files)) {
        write(join(dir, name), text);
    }
    return dir;
};

const codeOf = async (dir: string): Promise<string[]> => (await pluginHooks(dir, (path) => path)).code.map((file) => relative(dir, file));

test("code under node_modules is pinned, since a module can import it", async () => {
    const dir = pluginWith({ "hooks/register.ts": "import '../node_modules/x/i.js';\n", "node_modules/x/i.js": "export const a = 1;\n" });
    expect(await codeOf(dir)).toContain("node_modules/x/i.js");
});

test("code behind a symlinked directory is pinned, and a link back up the tree does not loop the walk", async () => {
    const outside = mkdtempSync(join(tmpdir(), "plugin-hooks-outside-"));
    write(join(outside, "l.js"), "export const b = 1;\n");
    const dir = pluginWith({ "hooks/register.ts": "import '../lib/l.js';\n" });
    symlinkSync(outside, join(dir, "lib"));
    symlinkSync(dir, join(dir, "lib-up"));
    const code = await codeOf(dir);
    expect(code).toContain("lib/l.js");
    expect(code.filter((file) => file.endsWith("register.ts"))).toEqual(["hooks/register.ts"]);
});
