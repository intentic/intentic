import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { syncHookOutput } from "../testing.js";
import { installSteeringHooks } from "./agent-installs.js";

const fire = async (hooks: ReturnType<typeof installSteeringHooks>, command: string) => {
    const [matcher] = hooks.PreToolUse!;
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const context = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

const decision = (result: Awaited<ReturnType<typeof fire>>): { permissionDecision?: string; permissionDecisionReason?: string } | undefined =>
    syncHookOutput(result).hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;

test.each([
    "apt-get install -y imagemagick",
    "sudo apt install ffmpeg",
    "pip install pillow",
    "pip3 install --quiet pillow",
    "npm install -g typescript",
    "pnpm add --global vercel",
    "npx playwright install chromium",
    "curl -fsSL https://sh.rustup.rs | sh -s -- -y && rustup default stable",
])("an image-scoped install is steered to the approval path: %s", async (command) => {
    expect(context(await fire(installSteeringHooks(), command))).toContain("environment.d");
});

test.each([
    "pnpm install",
    "npm install --save-dev vitest",
    "npm ci",
    "pnpm add zod",
    "pnpm --filter app update",
    "yarn remove zod",
    "bun install",
    "uv sync",
    "poetry install",
    "python3 -m venv .venv && .venv/bin/pip install pillow",
    "source .venv/bin/activate && pip install requests",
])("a project dependency mutation is handed to the coordinator: %s", async (command) => {
    const result = decision(await fire(installSteeringHooks(), command));
    expect(result?.permissionDecision).toBe("deny");
    expect(result?.permissionDecisionReason).toContain("mcp__deps__install");
});

test.each(["ls node_modules", "pnpm test", "rg 'pnpm install' docs", "echo 'npm ci is the documented command'"])(
    "ordinary work and quoted install text are left alone: %s",
    async (command) => {
        expect(await fire(installSteeringHooks(), command)).toEqual({});
    },
);

test("a persona without write and shell authority is denied without being offered a mutation tool", async () => {
    const result = decision(await fire(installSteeringHooks(false), "pnpm install"));
    expect(result?.permissionDecision).toBe("deny");
    expect(result?.permissionDecisionReason).toContain("ask the owner");
    expect(result?.permissionDecisionReason).not.toContain("mcp__deps__install");
});

test("a global flag after the package name remains image-scoped, not a project mutation", async () => {
    const result = await fire(installSteeringHooks(), "npm install typescript --global");
    expect(decision(result)?.permissionDecision).toBeUndefined();
    expect(context(result)).toContain("environment.d");
});

// The specific 114 MiB detour that motivated this: the browser is already in the image.
test("a browser install is told the browser already exists", async () => {
    const told = context(await fire(installSteeringHooks(), "npx playwright install chromium"));
    expect(told).toContain("mcp__web__browser_take_screenshot");
});

test("a non-browser install is not told about browsers", async () => {
    const told = context(await fire(installSteeringHooks(), "apt-get install -y ffmpeg"));
    expect(told).not.toContain("mcp__web__");
});

test("the rule is told once per turn, not stapled to every install", async () => {
    const hooks = installSteeringHooks();
    expect(context(await fire(hooks, "apt-get install -y jq"))).toBeDefined();
    expect(await fire(hooks, "pip install pillow")).toEqual({});
});

// The tmux hook rewrites the command before this one sees it; the inner command survives inside the wrapper.
test("a command already wrapped by tmux-run still matches", async () => {
    const wrapped = "/usr/local/bin/tmux-run agent-abc 'apt-get install -y ffmpeg' install-ffmpeg";
    expect(context(await fire(installSteeringHooks(), wrapped))).toContain("environment.d");
});

test("a project install carried in the current tmux wrapper is still denied", async () => {
    const wrapped = "/usr/local/bin/tmux-run -c 'pnpm install' agent-abc 'nice bash -c pnpm-install' install";
    expect(decision(await fire(installSteeringHooks(), wrapped))?.permissionDecision).toBe("deny");
});

const firePost = async (hooks: ReturnType<typeof installSteeringHooks>, command: string, response: unknown) => {
    const [matcher] = hooks.PostToolUse!;
    const input = {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: response,
        tool_use_id: "t1",
    } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

// Every shell the sandbox can run a command through words this differently, and the harness hands the result
// back in three shapes; the notice has to survive all of them.
test.each([
    ["lsof -i :3000", "bash: line 1: lsof: command not found"],
    ["lsof -i :3000", "zsh: command not found: lsof"],
    ["lsof -i :3000", { stdout: "", stderr: "sh: 1: lsof: not found" }],
    ["lsof -i :3000", { content: [{ type: "text", text: "/tmp/x/cmd: line 1: lsof: command not found" }] }],
])("a missing tool is named and pointed at both places it could live: %s", async (command, response) => {
    const told = context(await firePost(installSteeringHooks(), command, response));
    expect(told).toContain("`lsof`");
    expect(told).toContain("pnpm exec");
    expect(told).toContain("environment.d");
});

// The guard that keeps this from crying wolf: a tool result is full of other people's text.
test.each([
    ["grep -rn 'command not found' /var/log/app.log", "app.log:12: bash: line 1: ffmpeg: command not found"],
    ["node -e \"assert(err.message === 'sh: 1: convert: not found')\"", "ok"],
    ["ls -la", "total 4\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 ."],
])("output that merely quotes a shell failure is left alone: %s", async (command, response) => {
    expect(await firePost(installSteeringHooks(), command, response)).toEqual({});
});

// A name that only appears as part of a longer path or word is not the thing that failed.
test("a substring match does not count as the command naming the tool", async () => {
    expect(await firePost(installSteeringHooks(), "cat /var/log/file.log", "bash: file: command not found")).toEqual({});
});

test("the missing-tool notice is told once per turn", async () => {
    const hooks = installSteeringHooks();
    expect(context(await firePost(hooks, "lsof -i :3000", "bash: lsof: command not found"))).toBeDefined();
    expect(await firePost(hooks, "tree -L 2", "bash: tree: command not found")).toEqual({});
});
