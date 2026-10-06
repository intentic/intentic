import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { ClassifiedInstall } from "../../../environment/runtime-installs.js";
import { syncHookOutput } from "../../../testing.js";
import { classifyImageInstalls, installSteeringHooks, projectInstallsOf } from "../agent-installs.js";

const fire = async (hooks: ReturnType<typeof installSteeringHooks>, command: string, cwd = WORKSPACE_ROOT) => {
    const [matcher] = hooks.PreToolUse!;
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1", cwd } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const context = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

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

// The hook: loud only when it changes the model's next move.

// Recording the image install for the ledger is the command gate's, for every runtime (command-guard.test.ts).

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

// Every spelling of a project install is found, so the command gate's install rule reaches it (command-guard.test.ts).
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
])("a project dependency mutation is found: %s", (command) => {
    expect(projectInstallsOf(command, "/work/app")).toHaveLength(1);
});

test.each([
    // The image's, not a project's.
    "npm install typescript --global",
    "npm install -g typescript",
    // Read, not run.
    "rg 'pnpm install' docs",
    "echo 'npm ci is the documented command'",
    "pnpm run install-hooks",
])("what is not a project install is not found as one: %s", (command) => {
    expect(projectInstallsOf(command, "/work/app")).toEqual([]);
});

// A wrapper, an option's value or a manager's own spelling does not hide an install from the rule that judges it.
test.each([
    "bash -c 'npm install x'",
    `sh -c "pnpm add x"`,
    "bash -lc 'pnpm install'",
    "time npm i",
    "command pnpm install",
    "exec npm i",
    "nohup npm i &",
    "xargs npm install",
    "xargs -n 1 npm install",
    "if npm i; then echo ok; fi",
    "{ npm i; }",
    "eval 'npm i'",
    "echo start; `npm i`",
    "yarn",
    "yarn --frozen-lockfile",
    "npm --registry https://r.example.com i x",
    "npm -w pkg i x",
    "npm --workspace pkg install x",
    "yarn workspace foo add bar",
    "npm --loglevel silent i",
    "pnpm --reporter silent i",
    "pnpm -w add x",
    "pnpm rebuild",
    "npm rebuild",
    "npm audit fix",
    "npm isntall x",
    "bun a x",
    "uv add requests",
    "uv remove requests",
    "uv pip install requests",
    "uv --directory svc sync",
    ".venv/bin/python -m pip install pillow",
    "source .venv/bin/activate && python3 -m pip install requests",
])("a project install behind a wrapper or an option is found: %s", (command) => {
    expect(projectInstallsOf(command, "/work/app")).toHaveLength(1);
});

test.each([
    // Nothing is installed.
    "npm i --dry-run",
    "pnpm add --help",
    "npm install -h",
    "yarn --version",
    "yarn run build",
    "yarn test",
    "uv run pytest",
    "uv add --dry-run requests",
    "time pnpm test",
    "command -v npm",
    "nohup pnpm dev &",
    "cargo add serde",
    // The image's, not a project's.
    "uv pip install --system requests",
    "python3 -m pip install requests",
])("what installs nothing, or installs into the image, is not a project install: %s", (command) => {
    expect(projectInstallsOf(command, "/work/app")).toEqual([]);
});

test("python's own pip, and uv's with --system, are image installs like pip itself", () => {
    expect(classifyImageInstalls("python3 -m pip install requests")).toEqual([{ kind: "pip", tool: "requests" }]);
    expect(classifyImageInstalls("uv pip install --system requests")).toEqual([{ kind: "pip", tool: "requests" }]);
    expect(classifyImageInstalls(".venv/bin/python -m pip install requests")).toEqual([]);
});

// A `cd` in a subshell, a command substitution or before a `popd` does not move the shell for what follows.
test.each<[string, { dir: string; ecosystem: "node" | "python" }[]]>([
    ["(cd /tmp/scratch && pnpm install); pnpm install", [{ dir: "/tmp/scratch", ecosystem: "node" }, { dir: "/work/app", ecosystem: "node" }]],
    ["(cd sub && ls); pnpm install", [{ dir: "/work/app", ecosystem: "node" }]],
    ["pushd sub && npm i && popd && npm i", [{ dir: "/work/app/sub", ecosystem: "node" }, { dir: "/work/app", ecosystem: "node" }]],
    ['cd "$(git rev-parse --show-toplevel)" && pnpm install', [{ dir: "/work/app", ecosystem: "node" }]],
    ["cd $REPO && pnpm install", [{ dir: "/work/app", ecosystem: "node" }]],
    ["bash -c 'cd sub && npm i'; npm i", [{ dir: "/work/app/sub", ecosystem: "node" }, { dir: "/work/app", ecosystem: "node" }]],
])("an install is located where its own shell stands: %s", (command, expected) => {
    expect(projectInstallsOf(command, "/work/app")).toEqual(expected);
});

test("a project install carried in the current tmux wrapper is still found", () => {
    const wrapped = "/usr/local/bin/tmux-run -c 'pnpm install' agent-abc 'nice bash -c pnpm-install' install";
    expect(projectInstallsOf(wrapped, "/work/app")).toEqual([{ dir: "/work/app", ecosystem: "node" }]);
});

test("an install after a test on the same line is still found: the first manager verb does not end the search", () => {
    expect(projectInstallsOf("pnpm test && pnpm install", "/work/app")).toEqual([{ dir: "/work/app", ecosystem: "node" }]);
});

// Where each install works decides what is prepared for it: the directory the shell stands in when it gets there.
test.each<[string, string, { dir: string; ecosystem: "node" | "python" }[]]>([
    ["npm install remotion", `${WORKSPACE_ROOT}/video`, [{ dir: `${WORKSPACE_ROOT}/video`, ecosystem: "node" }]],
    ["mkdir -p app && cd app && npm init -y && npm install zod", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/app`, ecosystem: "node" }]],
    ["cd /work/video && pnpm add remotion", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/video`, ecosystem: "node" }]],
    ["pnpm -C web add zod", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/web`, ecosystem: "node" }]],
    ["pnpm --dir=web install", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/web`, ecosystem: "node" }]],
    ["npm --prefix ../site ci", `${WORKSPACE_ROOT}/app`, [{ dir: `${WORKSPACE_ROOT}/site`, ecosystem: "node" }]],
    ["yarn --cwd api add left-pad", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/api`, ecosystem: "node" }]],
    ["cd ~ && pnpm install", `${WORKSPACE_ROOT}/app`, [{ dir: `${WORKSPACE_ROOT}/app`, ecosystem: "node" }]],
    ["uv sync --directory tools", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/tools`, ecosystem: "python" }]],
    ["cd svc && python3 -m venv .venv && .venv/bin/pip install pillow", WORKSPACE_ROOT, [{ dir: `${WORKSPACE_ROOT}/svc`, ecosystem: "python" }]],
    [
        "cd a && pnpm install && cd ../b && npm ci",
        WORKSPACE_ROOT,
        [
            { dir: `${WORKSPACE_ROOT}/a`, ecosystem: "node" },
            { dir: `${WORKSPACE_ROOT}/b`, ecosystem: "node" },
        ],
    ],
])("an install is located where it runs: %s", (command, cwd, expected) => {
    expect(projectInstallsOf(command, cwd)).toEqual(expected);
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
