import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { claudeCliPath } from "../engines/claude-sdk.js";
import { claudeModuleReader } from "./plugin-modules.js";

// The pinned CLI reading a real mod on disk, without running it. CI's image carries the SDK's binary.
const cli = claudeCliPath();
const withCli = requires(cli !== undefined, "the Claude Code binary the SDK ships");

const writeMod = async (register: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-modules-"));
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await mkdir(join(dir, "hooks"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "probe", version: "0.1.0", description: "a probe" }));
    await writeFile(join(dir, "hooks", "hooks.json"), JSON.stringify({ modules: ["./register.ts"] }));
    await writeFile(join(dir, "hooks", "register.ts"), register);
    return dir;
};

test.skipIf(!withCli.runs)(withCli.title("the CLI's own reading of a mod names what it hooks and what it reaches for"), async () => {
    const dir = await writeMod(
        `export const register = (on) => {\n  on("tool.call", { tool: "Bash" }, async ($, e, next) => { await $.process.spawn({ command: "x" }); await $.http.fetch({ url: "https://example.com" }); return next(e); });\n};\n`,
    );

    expect(await claudeModuleReader(cli)(dir, "./register.ts")).toEqual({ hooks: ["tool.call{tool=Bash}"], calls: ["$.http.fetch", "$.process.spawn"] });
});

test.skipIf(!withCli.runs)(withCli.title("a mod that does not parse is said to be unreadable, with the CLI's reason"), async () => {
    const dir = await writeMod(`export const register = (on) => { on("x", `);

    const summary = await claudeModuleReader(cli)(dir, "./register.ts");
    expect(summary).toMatchObject({ hooks: [], calls: [] });
    expect(summary.unreadable).toContain("does not parse");
});

test("with no CLI found the module is unreadable, and nothing throws", async () => {
    expect(await claudeModuleReader(undefined)("/nowhere", "./register.ts")).toEqual({
        hooks: [],
        calls: [],
        unreadable: "this sandbox's Claude Code was not found",
    });
});
