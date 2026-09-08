import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { syncHookOutput } from "../../testing.js";
import { dependencyDirForCommand, depsNoticeHooks } from "./agent-deps.js";

// Fake tree probe reporting exactly these names missing; `walks` counts calls, since not re-asking is half of what's
// tested.
const treeMissing = (names: string[], walks: { count: number } = { count: 0 }) => {
    const probe = async () => {
        walks.count += 1;
        return { dir: "app", state: "stale" as const, names };
    };
    return { probe, walks };
};

const fire = async (hooks: ReturnType<typeof depsNoticeHooks>, output: string, command = "pnpm test") => {
    const [matcher] = hooks.PostToolUse!;
    const input = {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: "", stderr: output },
        tool_use_id: "t1",
    } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const context = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

test.each([
    `Error: Cannot find module 'vue'`,
    `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vue' imported from /work/app/src/main.ts`,
    `src/main.ts(1,18): error TS2307: Cannot find module 'vue' or its corresponding type declarations.`,
    `[vite]: Rollup failed to resolve import "vue/dist/vue.esm-bundler.js" from "src/main.ts"`,
    `Failed to resolve import "vue" from "src/main.ts". Does the file exist?`,
])("a command that failed on a package the tree really lacks is told why: %s", async (output) => {
    const { probe } = treeMissing(["vue"]);
    expect(context(await fire(depsNoticeHooks(probe, true), output))).toMatch(/install being behind/i);
});

test("a mistyped import stays the agent's own problem, because the tree has that package", async () => {
    const { probe } = treeMissing(["left-pad"]);
    expect(await fire(depsNoticeHooks(probe, true), `Error: Cannot find module 'vuee'`)).toEqual({});
});

test("an unresolved relative path is never excused: it cannot be a declared dependency", async () => {
    const { probe } = treeMissing(["vue"]);
    expect(await fire(depsNoticeHooks(probe, true), `Error: Cannot find module './helpres.js'`)).toEqual({});
});

test("a command that failed for any other reason is left alone", async () => {
    const { probe, walks } = treeMissing(["vue"]);
    expect(await fire(depsNoticeHooks(probe, true), "3 tests failed: expected 2 to be 3")).toEqual({});
    expect(walks.count).toBe(0);
});

test("searching a build log that quotes an unresolved import does not count as running the build", async () => {
    const { probe, walks } = treeMissing(["vue"]);
    expect(await fire(depsNoticeHooks(probe, true), `Cannot find module 'vue'`, "rg 'Cannot find module' build.log")).toEqual({});
    expect(walks.count).toBe(0);
});

test("a scoped subpath import is answered for by its package", async () => {
    const { probe } = treeMissing(["@intentic/sandbox-contract"]);
    const told = context(await fire(depsNoticeHooks(probe, true), `Cannot find module '@intentic/sandbox-contract/chores'`));
    expect(told).toContain("@intentic/sandbox-contract");
});

test("the reason is given once per package, not stapled to every retry", async () => {
    const { probe } = treeMissing(["vue"]);
    const hooks = depsNoticeHooks(probe, true);
    expect(context(await fire(hooks, `Cannot find module 'vue'`))).toEqual(expect.any(String));
    expect(await fire(hooks, `Cannot find module 'vue'`)).toEqual({});
});

test("a name the tree has already answered for is not looked up twice", async () => {
    const { probe, walks } = treeMissing(["vue"]);
    const hooks = depsNoticeHooks(probe, true);
    await fire(hooks, `Cannot find module 'vuee'`);
    await fire(hooks, `Cannot find module 'vuee'`);
    await fire(hooks, `Cannot find module 'vuee'`);
    expect(walks.count).toBe(1);
});

test("a project with no dependency issue is not probed again on every failure", async () => {
    let reads = 0;
    const hooks = depsNoticeHooks(async () => {
        reads += 1;
        return undefined;
    }, true);
    await fire(hooks, `Cannot find module 'vuee'`);
    await fire(hooks, `Cannot find module 'vuee'`);
    expect(reads).toBe(1);
});

test("an explicit cd scopes a root-started turn to the project it actually tested", async () => {
    expect(dependencyDirForCommand("", "/work", "cd app && pnpm test")).toBe("app");
    expect(dependencyDirForCommand("app/src", "/work", "cd ../.. && pnpm test")).toBe("");
    expect(dependencyDirForCommand("app", "/work", "cd /work/other && pnpm test")).toBe("other");
    expect(dependencyDirForCommand("app", "/work", "cd ../../outside && pnpm test")).toBe("app");
    expect(dependencyDirForCommand("app", "/work", "cd /tmp && pnpm test")).toBe("app");
});

test("a negative answer for one command does not hide a later failure in another project", async () => {
    const hooks = depsNoticeHooks(async (command) => (command.includes("cd app") ? { dir: "app", state: "stale", names: ["vue"] } : undefined), true);
    expect(await fire(hooks, `Cannot find module 'vue'`, "pnpm test")).toEqual({});
    expect(context(await fire(hooks, `Cannot find module 'vue'`, "cd app && pnpm test"))).toMatch(/install being behind/i);
});

test("a tree that cannot be read produces no notice rather than a guessed one", async () => {
    const hooks = depsNoticeHooks(async () => {
        throw new Error("EACCES");
    }, true);
    expect(await fire(hooks, `Cannot find module 'vue'`)).toEqual({});
});

test("a never-installed project asks for setup rather than promising an automatic repair", async () => {
    const hooks = depsNoticeHooks(async () => ({ dir: "app", state: "needs-setup", names: ["vue"] }), true);
    const told = context(await fire(hooks, `Cannot find module 'vue'`));
    expect(told).toContain("mcp__deps__install");
    expect(told).not.toContain("queued its repair");
});

test("a read-only persona is told to ask the owner for first-time setup", async () => {
    const hooks = depsNoticeHooks(async () => ({ dir: "app", state: "needs-setup", names: ["vue"] }), false);
    expect(context(await fire(hooks, `Cannot find module 'vue'`))).toMatch(/ask the owner/i);
});
