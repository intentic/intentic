import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import type { ClassifiedInstall } from "../../environment/runtime-installs.js";
import { syncHookOutput } from "../../testing.js";
import { classifyImageInstalls, installSteeringHooks } from "./agent-installs.js";

const fire = async (hooks: ReturnType<typeof installSteeringHooks>, command: string) => {
    const [matcher] = hooks.PreToolUse!;
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const context = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

const decision = (result: Awaited<ReturnType<typeof fire>>): { permissionDecision?: string; permissionDecisionReason?: string } | undefined =>
    syncHookOutput(result).hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;

// Classification is the ledger's input; precision here is the ledger's meaning.

test.each<[string, ClassifiedInstall[]]>([
    ["apt-get install -y imagemagick", [{ kind: "apt", tool: "imagemagick" }]],
    [
        "sudo apt install ffmpeg jq",
        [
            { kind: "apt", tool: "ffmpeg" },
            { kind: "apt", tool: "jq" },
        ],
    ],
    ["apt-get -y -qq install --no-install-recommends p7zip-full", [{ kind: "apt", tool: "p7zip-full" }]],
    ["pip install pillow", [{ kind: "pip", tool: "pillow" }]],
    ["pip3 install --break-system-packages ziglang==0.11", [{ kind: "pip", tool: "ziglang" }]],
    ["cargo install --locked cargo-xwin", [{ kind: "cargo", tool: "cargo-xwin" }]],
    ["cargo install cargo-zigbuild@1.2.0", [{ kind: "cargo", tool: "cargo-zigbuild" }]],
    ["rustup target add x86_64-pc-windows-msvc", [{ kind: "rustup-target", tool: "x86_64-pc-windows-msvc" }]],
    ["npx playwright install chromium", [{ kind: "playwright", tool: "chromium" }]],
    ["pnpm --filter @intentic/e2e exec playwright install chromium", [{ kind: "playwright", tool: "chromium" }]],
    ["npx playwright install", [{ kind: "playwright", tool: "chromium" }]],
    ["timeout 600 npx playwright install chromium", [{ kind: "playwright", tool: "chromium" }]],
    ["npm install -g typescript", [{ kind: "npm", tool: "typescript" }]],
    ["npm i -g @openai/codex@0.147.0", [{ kind: "npm", tool: "@openai/codex" }]],
    ["pnpm add --global vercel", [{ kind: "npm", tool: "vercel" }]],
    ["go install golang.org/x/tools/gopls@latest", [{ kind: "go", tool: "gopls" }]],
    ["gem install rails", [{ kind: "gem", tool: "rails" }]],
    ["pipx install ruff", [{ kind: "pipx", tool: "ruff" }]],
    ["curl -fsSL https://bun.sh/install | bash", [{ kind: "other", tool: "bun.sh" }]],
    ["dpkg -i /tmp/mytool_1.0_amd64.deb", [{ kind: "other", tool: "mytool" }]],
    // A real install still classifies when redirected, piped, or chained after a `cd`.
    ["npx playwright install chromium-headless-shell 2>&1 | tail -8", [{ kind: "playwright", tool: "chromium-headless-shell" }]],
    ["apt-get install -y -qq xdotool 2>&1 | tail -3; which xdotool", [{ kind: "apt", tool: "xdotool" }]],
    ["pip install --quiet zizmor 2>&1 | tail -3", [{ kind: "pip", tool: "zizmor" }]],
    ["rustup component add clippy 2>&1 | tail -1", [{ kind: "other", tool: "rustup-component-clippy" }]],
    ["apt-get install -y ffmpeg > /tmp/apt.log 2>/dev/null", [{ kind: "apt", tool: "ffmpeg" }]],
    ["(uvx --from zizmor zizmor --version || pip install zizmor)", [{ kind: "pip", tool: "zizmor" }]],
])("an install command names its tools: %s", (command, expected) => {
    expect(classifyImageInstalls(command)).toEqual(expected);
});

test.each([
    // Not installs at all.
    "rustup target list --installed",
    "cargo build --release",
    "apt-get install --dry-run nsis",
    "ls node_modules",
    "rg 'pnpm install' docs",
    "echo 'npm ci is the documented command'",
    // A venv pip is project scope, not image scope.
    "source .venv/bin/activate && pip install requests",
    // A requirements install is a project's dependency set, not a tool.
    "pip install -r requirements.txt",
    // A global removal is not an install.
    "npm uninstall -g typescript",
    // Inside another container: mutates that container's filesystem, not this one.
    "docker run --rm node:24 bash -c 'apt-get update && apt-get install -y tmux'",
    // A quoted argument is not a command: splitting on | or ; can turn a search pattern into an install.
    'rg -n "^FROM|^ARG NODE|apt-get install -y --no-install-recommends" _sandbox/sandbox/Dockerfile | head -20',
    'rg -n "irm |iex|curl.*\\| sh|SANDBOX_URL=" src/inventory/enroll-host.ts | head -10',
    "echo 'RUN apt-get update && apt-get install -y curl ca-certificates' > /tmp/frag",
    // A heredoc's lines are data to the shell, not commands it runs.
    "python3 - <<'PYEOF'\nsubprocess.run('apt-get install -y tmux')\nprint('pip install requests')\nPYEOF",
])("what is not an image install of this container classifies as nothing: %s", (command) => {
    expect(classifyImageInstalls(command)).toEqual([]);
});

// The inner command survives unwrapping by the tmux hook.
test("a command already wrapped by tmux-run still classifies", () => {
    const wrapped = "/usr/local/bin/tmux-run agent-abc 'apt-get install -y ffmpeg' install-ffmpeg";
    expect(classifyImageInstalls(wrapped)).toEqual([{ kind: "apt", tool: "ffmpeg" }]);
});

// The hook: silent recording, loud only when it changes the model's next move.

test("an image-scoped install is recorded silently, not lectured", async () => {
    const recorded: { installs: readonly ClassifiedInstall[]; command: string }[] = [];
    const hooks = installSteeringHooks(true, (installs, command) => recorded.push({ installs, command }));
    const result = await fire(hooks, "apt-get install -y imagemagick");
    expect(context(result)).toBeUndefined();
    expect(recorded).toEqual([{ installs: [{ kind: "apt", tool: "imagemagick" }], command: "apt-get install -y imagemagick" }]);
});

test("every install is recorded, not just the first", async () => {
    const recorded: string[] = [];
    const hooks = installSteeringHooks(true, (installs) => recorded.push(...installs.map((install) => install.tool)));
    await fire(hooks, "apt-get install -y jq");
    await fire(hooks, "pip install pillow");
    expect(recorded).toEqual(["jq", "pillow"]);
});

test("the recorded command is the agent's own, unwrapped from tmux", async () => {
    const recorded: string[] = [];
    const hooks = installSteeringHooks(true, (_installs, command) => recorded.push(command));
    await fire(hooks, "/usr/local/bin/tmux-run agent-abc 'apt-get install -y ffmpeg' install-ffmpeg");
    expect(recorded).toEqual(["apt-get install -y ffmpeg"]);
});

test("a browser install is told the browser already exists", async () => {
    const told = context(await fire(installSteeringHooks(), "npx playwright install chromium"));
    expect(told).toContain("mcp__web__browser_take_screenshot");
});

test("a non-browser install is told nothing", async () => {
    expect(await fire(installSteeringHooks(), "apt-get install -y ffmpeg")).toEqual({});
});

test("the browser notice is told once per turn", async () => {
    const hooks = installSteeringHooks();
    expect(context(await fire(hooks, "npx playwright install chromium"))).toEqual(expect.any(String));
    expect(await fire(hooks, "npx playwright install firefox")).toEqual({});
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

test("a persona without write and shell authority is denied without being offered a mutation tool", async () => {
    const result = decision(await fire(installSteeringHooks(false), "pnpm install"));
    expect(result?.permissionDecision).toBe("deny");
    expect(result?.permissionDecisionReason).not.toContain("mcp__deps__install");
});

test("a global flag after the package name remains image-scoped, not a project mutation", async () => {
    const recorded: (readonly ClassifiedInstall[])[] = [];
    const hooks = installSteeringHooks(true, (installs) => recorded.push(installs));
    const result = await fire(hooks, "npm install typescript --global");
    expect(decision(result)?.permissionDecision).toBeUndefined();
    expect(recorded).toEqual([[{ kind: "npm", tool: "typescript" }]]);
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

// Response shapes vary by shell; the notice must survive each one.
test.each([
    ["lsof -i :3000", "bash: line 1: lsof: command not found"],
    ["lsof -i :3000", "zsh: command not found: lsof"],
    ["lsof -i :3000", { stdout: "", stderr: "sh: 1: lsof: not found" }],
    ["lsof -i :3000", { content: [{ type: "text", text: "/tmp/x/cmd: line 1: lsof: command not found" }] }],
])("a missing tool is named and routed, with installing declared safe: %s", async (command, response) => {
    const told = context(await firePost(installSteeringHooks(), command, response));
    expect(told).toContain("`lsof`");
    expect(told).toContain("pnpm exec");
    expect(told).toMatch(/records runtime installs/i);
});

test.each([
    ["grep -rn 'command not found' /var/log/app.log", "app.log:12: bash: line 1: ffmpeg: command not found"],
    ["node -e \"assert(err.message === 'sh: 1: convert: not found')\"", "ok"],
    ["ls -la", "total 4\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 ."],
])("output that merely quotes a shell failure is left alone: %s", async (command, response) => {
    expect(await firePost(installSteeringHooks(), command, response)).toEqual({});
});

test("a substring match does not count as the command naming the tool", async () => {
    expect(await firePost(installSteeringHooks(), "cat /var/log/file.log", "bash: file: command not found")).toEqual({});
});

test("the missing-tool notice is told once per turn", async () => {
    const hooks = installSteeringHooks();
    expect(context(await firePost(hooks, "lsof -i :3000", "bash: lsof: command not found"))).toEqual(expect.any(String));
    expect(await firePost(hooks, "tree -L 2", "bash: tree: command not found")).toEqual({});
});

// The real report carries a script line (`sh: 1: x: not found`); an echoed fallback string does not.
test("a shell naming itself in echoed text is not a missing shell", async () => {
    expect(await firePost(installSteeringHooks(), "sh -c 'command -v oxlint || echo \"sh: not found\"'", "sh: not found")).toEqual({});
});

test("a tool missing inside a shell wrapper is still named", async () => {
    const told = context(await firePost(installSteeringHooks(), "sh -c 'lsof -i :3000'", "sh: 1: lsof: not found"));
    expect(told).toContain("`lsof`");
});

// Backticks inside a double-quoted argument are command substitution; the pattern never reaches the tool it names.
test("a substituted backtick is answered with the quoting fix, not an install", async () => {
    const told = context(
        await firePost(installSteeringHooks(), 'rg -n "kind: `ask`|decision" conversation.test.ts', "bash: line 1: ask: command not found"),
    );
    expect(told).toContain("`ask`");
    expect(told).toMatch(/command substitution/i);
    expect(told).toMatch(/single-quote|escape the backticks/i);
    expect(told).not.toMatch(/pnpm exec|records runtime installs/i);
});

test("the substitution notice and the missing-tool notice are latched apart", async () => {
    const hooks = installSteeringHooks();
    expect(context(await firePost(hooks, 'echo "`ask`"', "bash: line 1: ask: command not found"))).toMatch(/command substitution/i);
    expect(context(await firePost(hooks, "lsof -i :3000", "bash: lsof: command not found"))).toMatch(/records runtime installs/i);
});
