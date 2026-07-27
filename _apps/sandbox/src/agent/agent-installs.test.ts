import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { installSteeringHooks } from "./agent-installs.js";

const fire = async (hooks: ReturnType<typeof installSteeringHooks>, command: string) => {
    const [matcher] = hooks.PreToolUse!;
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const context = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (result.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

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
    "pnpm add zod",
    "python3 -m venv .venv && .venv/bin/pip install pillow",
    "source .venv/bin/activate && pip install requests",
    "ls node_modules",
])("project-scoped work is left alone: %s", async (command) => {
    expect(await fire(installSteeringHooks(), command)).toEqual({});
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
