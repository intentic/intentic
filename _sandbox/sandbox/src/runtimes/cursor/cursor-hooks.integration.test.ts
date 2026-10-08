import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CommandGuard } from "../../guard/command-guard.js";
import { createLogger } from "../../logger.js";
import { createCursorHookService, type CursorHookService, type CursorHookShield } from "./cursor-hooks.js";
import { shieldedCommand, unshieldedCommand } from "./cursor-hook-script.js";

// Cursor's turn hooks end to end: the generated script runs as a real child process, not a stub. Cursor itself reading
// /etc/cursor/hooks.json is the one part no test here can drive; the file's content is pinned instead.

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

let service: CursorHookService | undefined;
// Enterprise hooks file is machine-global in production; pointed at a temp file so the suite needs no /etc access.
let hooksFile = "";
beforeEach(() => {
    hooksFile = join(mkdtempSync(join(tmpdir(), "cursor-etc-")), "hooks.json");
    process.env["INTENTIC_CURSOR_HOOKS_FILE"] = hooksFile;
});
afterEach(async () => {
    await service?.close();
    service = undefined;
    delete process.env["INTENTIC_CURSOR_HOOKS_FILE"];
});

const started = async (): Promise<{ service: CursorHookService; dir: string }> => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-"));
    const created = createCursorHookService(dir, logger);
    await created.start();
    service = created;
    return { service: created, dir };
};

// Runs the generated script as Cursor would: a child process, payload on stdin, answer on stdout.
const askHook = async (dir: string, mode: "gate" | "session-env" | "prompt" | "pre-tool" | "read", payload: unknown): Promise<unknown> => {
    const child = execFile("node", [join(dir, "intentic-command-guard.mjs"), mode]);
    child.stdin?.end(JSON.stringify(payload));
    const stdout = await new Promise<string>((settle) => {
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", () => settle(out));
    });
    return JSON.parse(stdout);
};
const askGate = (dir: string, payload: unknown): Promise<unknown> => askHook(dir, "gate", payload);
const askSessionEnv = (dir: string, payload: unknown): Promise<unknown> => askHook(dir, "session-env", payload);
const askPrompt = (dir: string, payload: unknown): Promise<unknown> => askHook(dir, "prompt", payload);

// A gate that denies every command with the given reason.
const denying = (reason: string): CommandGuard => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    async *consult() {
        return { allow: false, reason };
    },
});
const allowing = (): CommandGuard => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    async *consult() {
        return { allow: true };
    },
});

test("a registered turn's denial reaches Cursor as a deny, with the reason in both messages", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: denying("Deleting files needs your approval."), push: () => {} });

    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1", cwd: "/work" })).toEqual({
        permission: "deny",
        agent_message: "Deleting files needs your approval.",
        user_message: "Deleting files needs your approval.",
    });
});

// The hook is failClosed for a script that never answers; a gate that answered with an error must not be looser.
test("a gate that fails refuses the command rather than letting it outrun its rules", async () => {
    const { service: hooks, dir } = await started();
    const gate: CommandGuard = {
        enforcing: true,
        // eslint-disable-next-line require-yield
        async *consult() {
            throw new Error("the card store is unwritable");
        },
    };
    hooks.register({ conversationId: "agent-1", gate, push: () => {} });
    const reason = "The command guard failed (the card store is unwritable), so this command was refused. Do not retry it: say plainly what you could not run.";
    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1" })).toEqual({ permission: "deny", agent_message: reason, user_message: reason });
});

// What the gate says about an allowed command (where an install writes) goes to the agent, and the shell's own cwd goes
// to the gate, the same two things Claude Code's hook carries.
test("an allowed command's note reaches the agent, and the shell's cwd reaches the gate", async () => {
    const { service: hooks, dir } = await started();
    const asked: (string | undefined)[] = [];
    const gate: CommandGuard = {
        enforcing: true,
        // eslint-disable-next-line require-yield
        async *consult(_program, _subject, where) {
            asked.push(where?.cwd);
            return { allow: true, context: "This install writes to this conversation's own copy of the tree." };
        },
    };
    hooks.register({ conversationId: "agent-1", gate, push: () => {} });
    expect(await askGate(dir, { command: "pnpm add zod", conversation_id: "agent-1", cwd: "/work/video" })).toEqual({
        permission: "allow",
        agent_message: "This install writes to this conversation's own copy of the tree.",
    });
    expect(asked).toEqual(["/work/video"]);
});

test("an allowed command comes back as a bare allow", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    expect(await askGate(dir, { command: "ls", conversation_id: "agent-1" })).toEqual({ permission: "allow" });
});

test("a registered turn receives its exact capability environment", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({
        conversationId: "agent-1",
        cliEnv: { DISCORD_BOT_TOKEN_DISCORD: "fake-token", INTENTIC_PERSONA: "release-editor" },
        gate: allowing(),
        push: () => {},
    });
    expect(await askSessionEnv(dir, { conversation_id: "agent-1" })).toEqual({
        env: { DISCORD_BOT_TOKEN_DISCORD: "fake-token", INTENTIC_PERSONA: "release-editor" },
    });
});

test("session environment requires an exact conversation id even with one turn running", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", cliEnv: { SECRET: "fake-secret" }, gate: allowing(), push: () => {} });
    expect(await askSessionEnv(dir, { conversation_id: "someone-elses-agent" })).toEqual({ env: {} });
    expect(await askSessionEnv(dir, {})).toEqual({ env: {} });
});

test("retiring a turn removes its capability environment", async () => {
    const { service: hooks, dir } = await started();
    const retire = hooks.register({ conversationId: "agent-1", cliEnv: { SECRET: "fake-secret" }, gate: allowing(), push: () => {} });
    retire();
    expect(await askSessionEnv(dir, { conversation_id: "agent-1" })).toEqual({ env: {} });
});

// The runtime's only system seam: without this hook the persona note, the workspace's standing instructions and the
// owner's own prompt are composed by turn-plan and then reach nothing.
test("a registered turn's standing instructions ride beforeSubmitPrompt as added context", async () => {
    const { service: hooks, dir } = await started();
    const append = "You are acting as release-editor.\n\nThe workspace forbids force pushes.";
    hooks.register({ conversationId: "agent-1", systemAppend: append, gate: allowing(), push: () => {} });
    expect(await askPrompt(dir, { conversation_id: "agent-1", prompt: "ship it" })).toEqual({ continue: true, additional_context: append });
});

// Same rule as the environment above, and for the same reason: the append names the persona and quotes the workspace's
// own rules, so it may never reach a Cursor process this daemon did not start.
test("added context requires an exact conversation id even with one turn running", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", systemAppend: "workspace rules", gate: allowing(), push: () => {} });
    expect(await askPrompt(dir, { conversation_id: "someone-elses-agent" })).toEqual({ continue: true });
    expect(await askPrompt(dir, {})).toEqual({ continue: true });
});

// An absent key, not a blank one: Cursor's own prompt must be left exactly as it was when there is nothing to add.
test("a turn with nothing to add sends no context key at all", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    expect(await askPrompt(dir, { conversation_id: "agent-1" })).toEqual({ continue: true });
    hooks.register({ conversationId: "agent-2", systemAppend: "", gate: allowing(), push: () => {} });
    expect(await askPrompt(dir, { conversation_id: "agent-2" })).toEqual({ continue: true });
});

test("a consult from no known turn is allowed rather than refused", async () => {
    const { dir } = await started();
    expect(await askGate(dir, { command: "rm -rf /", conversation_id: "someone-elses-agent" })).toEqual({ permission: "allow" });
});

test("an unlabelled consult is answered by the only turn running", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: denying("no"), push: () => {} });
    expect(await askGate(dir, { command: "rm -rf build" })).toMatchObject({ permission: "deny" });
});

test("with two turns running there is nothing to reason from, so it allows", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: denying("no"), push: () => {} });
    hooks.register({ conversationId: "agent-2", gate: denying("no"), push: () => {} });
    expect(await askGate(dir, { command: "rm -rf build" })).toEqual({ permission: "allow" });
});

test("a turn whose gate enforces nothing short-circuits to allow", async () => {
    const { service: hooks, dir } = await started();
    const gate: CommandGuard = {
        enforcing: false,
        // eslint-disable-next-line require-yield
        async *consult() {
            throw new Error("an unenforcing gate must never be consulted");
        },
    };
    hooks.register({ conversationId: "agent-1", gate, push: () => {} });
    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1" })).toEqual({ permission: "allow" });
});

test("retiring a turn stops it answering for its agent id", async () => {
    const { service: hooks, dir } = await started();
    const retire = hooks.register({ conversationId: "agent-1", gate: denying("no"), push: () => {} });
    retire();
    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1" })).toEqual({ permission: "allow" });
});

test("frames the gate yields are pushed to the turn's own stream", async () => {
    const { service: hooks, dir } = await started();
    const pushed: AgentEvent[] = [];
    // Real AgentEvent shape, not a cast-based stand-in a fake would slip through unnoticed.
    const card: AgentEvent = { kind: "permission", requestId: "r1", toolName: "Shell", displayName: "Run command", reason: "rule" };
    const gate: CommandGuard = {
        enforcing: true,
        async *consult() {
            yield card;
            return { allow: true };
        },
    };
    hooks.register({ conversationId: "agent-1", gate, push: (event) => pushed.push(event) });
    await askGate(dir, { command: "ls", conversation_id: "agent-1" });
    expect(pushed).toEqual([card]);
});

// The script answers for itself when it can't reach anyone, so a dead socket costs a turn nothing; failClosed in the
// hooks file covers the remaining case, the script itself being unrunnable.
test("a script that cannot reach the daemon fails safely rather than hanging", async () => {
    const { service: hooks, dir } = await started();
    await hooks.close();
    service = undefined;
    expect(await askGate(dir, { command: "ls", conversation_id: "agent-1" })).toEqual({ permission: "allow" });
    expect(await askSessionEnv(dir, { conversation_id: "agent-1" })).toEqual({});
    expect(await askPrompt(dir, { conversation_id: "agent-1" })).toEqual({ continue: true });
});

test("a payload that is not JSON is allowed rather than crashing the turn", async () => {
    const { dir } = await started();
    const child = execFile("node", [join(dir, "intentic-command-guard.mjs"), "gate"]);
    child.stdin?.end("not json at all");
    const out = await new Promise<string>((settle) => {
        let text = "";
        child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
        child.on("close", () => settle(text));
    });
    expect(JSON.parse(out)).toEqual({ permission: "allow" });
});

test("the hooks file promises exactly the shape Cursor is documented to read", async () => {
    const { dir } = await started();
    const script = join(dir, "intentic-command-guard.mjs");
    expect(readFileSync(script, "utf8")).toContain("permission");
    const installed = readFileSync(hooksFile, "utf8").trim();
    const parsed = JSON.parse(installed) as { version: number; hooks: Record<string, { command: string; failClosed?: boolean }[]> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.hooks)).toEqual(["sessionStart", "beforeSubmitPrompt", "beforeShellExecution", "preToolUse", "beforeReadFile", "afterFileEdit"]);
    expect(parsed.hooks["sessionStart"]?.[0]?.failClosed).toBe(false);
    expect(parsed.hooks["sessionStart"]?.[0]?.command).toBe(`node ${JSON.stringify(script)} session-env`);
    expect(parsed.hooks["beforeSubmitPrompt"]?.[0]?.failClosed).toBe(false);
    expect(parsed.hooks["beforeSubmitPrompt"]?.[0]?.command).toBe(`node ${JSON.stringify(script)} prompt`);
    // The one hook that must refuse when its own script cannot run: a command that outran its rules is what it exists
    // to stop, while a turn missing its environment or its instructions is merely degraded.
    expect(parsed.hooks["beforeShellExecution"]?.[0]?.failClosed).toBe(true);
    expect(parsed.hooks["beforeShellExecution"]?.[0]?.command).toBe(`node ${JSON.stringify(script)} gate`);
    // The privacy shield's two gates fail closed too: a tool call or a file read nobody checked is what they stop.
    expect(parsed.hooks["preToolUse"]?.[0]).toEqual({ command: `node ${JSON.stringify(script)} pre-tool`, failClosed: true });
    expect(parsed.hooks["beforeReadFile"]?.[0]).toEqual({ command: `node ${JSON.stringify(script)} read`, failClosed: true });
    expect(parsed.hooks["afterFileEdit"]?.[0]).toEqual({ command: `node ${JSON.stringify(script)} edited`, failClosed: false });
});

// A shielded turn runs only on a hooks file that names this daemon's script for every hook the shield reads through:
// an older build's file, or another daemon's, would let its reads and its commands' output past.
test("the hooks file covers the privacy shield only while it names this daemon's script for each of its hooks", async () => {
    const { service: hooks, dir } = await started();
    expect(await hooks.covers()).toBe(true);
    const script = join(dir, "intentic-command-guard.mjs");
    writeFileSync(hooksFile, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: `node ${JSON.stringify(script)} gate` }] } }));
    expect(await hooks.covers()).toBe(false);
    await hooks.close();
    service = undefined;
    expect(await hooks.covers()).toBe(false);
});

test("restarting over a socket a dead daemon left behind still binds", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    const second = createCursorHookService(dir, logger);
    await expect(second.start()).resolves.toBeUndefined();
    await second.close();
    await exec("true");
});

test("retiring an older registration preserves the replacement turn's gate", async () => {
    const { service: hooks, dir } = await started();
    const retire = hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    const retireReplacement = hooks.register({ conversationId: "agent-1", gate: denying("Replacement gate"), push: () => {} });
    retire();
    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1", cwd: "/work" })).toEqual({
        permission: "deny", agent_message: "Replacement gate", user_message: "Replacement gate",
    });
    retireReplacement();
    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1", cwd: "/work" })).toEqual({ permission: "allow" });
});

// THE PRIVACY SHIELD'S HOOKS, end to end through the generated script: a stand-in shield that finds a fixed word, so
// what is tested is the wiring (what reaches the shield, what Cursor is answered), not the detectors.
const SECRET = "SECRET-VALUE";
const TOKEN = "\u27e6NATIONAL_ID_1\u27e7";
const standInShield = (calls: string[] = []): CursorHookShield => ({
    read: async ({ path, content, image }) => {
        calls.push(`read ${path} ${image === undefined ? "text" : `image:${image.length}`}`);
        return content?.includes(SECRET) === true ? `${path} holds personal data.` : undefined;
    },
    tool: async ({ tool, input, existing }) => {
        calls.push(`tool ${tool}${existing === undefined ? "" : " existing"}`);
        if (tool === "Grep") {
            return { refuse: "Grep is off." };
        }
        const restored = JSON.parse(JSON.stringify(input).replaceAll(TOKEN, SECRET)) as Record<string, unknown>;
        return { input: JSON.stringify(restored) === JSON.stringify(input) ? undefined : restored };
    },
    shellOutput: async (output) => output.replaceAll(SECRET, TOKEN),
    edited: (content) => (content.includes(TOKEN) ? content.replaceAll(TOKEN, SECRET) : undefined),
});

// Runs a hook mode with no JSON answer expected (edited) or a raw command line (a wrapped shell command), as Cursor would.
const runScript = async (args: readonly string[], stdin?: string): Promise<{ stdout: string; code: number | null }> => {
    const child = execFile("node", args);
    child.stdin?.end(stdin ?? "");
    return new Promise((settle) => {
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.on("close", (code) => settle({ stdout, code }));
    });
};

describe("the privacy shield's hooks", () => {
    test("a turn the shield does not read lets every read and tool call through untouched", async () => {
        const { service: hooks, dir } = await started();
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: "/work/a.txt", content: SECRET })).toEqual({ permission: "allow" });
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Shell", tool_input: { command: "ls" } })).toEqual({});
    });

    test("a file holding personal data is refused with the shield's sentence; a clean one goes", async () => {
        const { service: hooks, dir } = await started();
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {}, shield: standInShield() });
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: "/work/a.txt", content: `id: ${SECRET}` })).toEqual({
            permission: "deny",
            user_message: "/work/a.txt holds personal data.",
        });
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: "/work/b.txt", content: "clean" })).toEqual({ permission: "allow" });
    });

    test("a picture is read by the script, where its path means what Cursor meant, and handed to the shield", async () => {
        const { service: hooks, dir } = await started();
        const calls: string[] = [];
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {}, shield: standInShield(calls) });
        const picture = join(dir, "scan.png");
        writeFileSync(picture, Buffer.from([1, 2, 3, 4]));
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: picture, content: "" })).toEqual({ permission: "allow" });
        expect(calls).toEqual([`read ${picture} image:4`]);
    });

    test("a refused tool is denied in both messages, and a tool's input comes back with its tokens read back", async () => {
        const { service: hooks, dir } = await started();
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {}, shield: standInShield() });
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Grep", tool_input: { pattern: "x" } })).toEqual({
            permission: "deny",
            user_message: "Grep is off.",
            agent_message: "Grep is off.",
        });
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Read", tool_input: { file_path: `/work/${TOKEN}.txt` } })).toEqual({
            updated_input: { file_path: `/work/${SECRET}.txt` },
        });
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Read", tool_input: { file_path: "/work/a.txt" } })).toEqual({});
    });

    test("a whole-file write carries what it would replace, read by the script", async () => {
        const { service: hooks, dir } = await started();
        const calls: string[] = [];
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {}, shield: standInShield(calls) });
        const target = join(dir, "notes.txt");
        writeFileSync(target, "old text");
        await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Write", tool_input: { file_path: target, content: "new" } });
        await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Write", tool_input: { file_path: join(dir, "fresh.txt"), content: "new" } });
        expect(calls).toEqual(["tool Write existing", "tool Write"]);
    });

    test("a shell command is wrapped to run through the script, whose output reaches Cursor masked, with the command's own exit code", async () => {
        const { service: hooks, dir } = await started();
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {}, shield: standInShield() });
        const answer = (await askHook(dir, "pre-tool", {
            conversation_id: "agent-1",
            tool_name: "Shell",
            tool_input: { command: `echo "id ${TOKEN}"; echo oops >&2; exit 3`, cwd: dir },
        })) as { updated_input: { command: string; cwd: string } };
        expect(answer.updated_input.cwd).toBe(dir);
        const wrapped = answer.updated_input.command;
        expect(wrapped).not.toContain(SECRET);
        expect(unshieldedCommand(wrapped)).toBe(`echo "id ${SECRET}"; echo oops >&2; exit 3`);
        // Run as Cursor's shell would run it: the real value goes into the command, its echo comes back as the token,
        // stderr folded in where it was printed.
        const run = await new Promise<{ stdout: string; code: number | null }>((settle) => {
            const child = execFile("/bin/sh", ["-c", wrapped]);
            let stdout = "";
            child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.on("close", (code) => settle({ stdout, code }));
        });
        expect(run.stdout).toBe(`id ${TOKEN}\noops\n`);
        expect(run.code).toBe(3);
    });

    test("the command gate reads what the model asked for, not the shield's wrapper", async () => {
        const { service: hooks, dir } = await started();
        const consulted: string[] = [];
        const recording: CommandGuard = {
            enforcing: true,
            // eslint-disable-next-line require-yield
            async *consult(command) {
                consulted.push(command);
                return { allow: true };
            },
        };
        hooks.register({ conversationId: "agent-1", gate: recording, push: () => {}, shield: standInShield() });
        const wrapped = shieldedCommand(join(dir, "intentic-command-guard.mjs"), "agent-1", "rm -rf build");
        await askGate(dir, { command: wrapped, conversation_id: "agent-1", cwd: "/work" });
        expect(consulted).toEqual(["rm -rf build"]);
    });

    test("output that outlives its turn is withheld, and a daemon that is gone withholds the rest", async () => {
        const { service: hooks, dir } = await started();
        const script = join(dir, "intentic-command-guard.mjs");
        const orphaned = await runScript([script, "shield", "agent-gone", Buffer.from(`echo ${SECRET}`).toString("base64")]);
        expect(orphaned.stdout).toContain("the turn that ran this command has ended");
        expect(orphaned.stdout).not.toContain(SECRET);
        await hooks.close();
        service = undefined;
        const unreachable = await runScript([script, "shield", "agent-1", Buffer.from(`echo ${SECRET}; exit 4`).toString("base64")]);
        expect(unreachable.stdout).toContain("withheld");
        expect(unreachable.stdout).not.toContain(SECRET);
        expect(unreachable.code).toBe(4);
    });

    test("an edit whose new lines carry tokens is written back with their values, and nothing is answered", async () => {
        const { service: hooks, dir } = await started();
        hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {}, shield: standInShield() });
        const file = join(dir, "client.md");
        writeFileSync(file, `Client: ${TOKEN}\n`);
        const out = await runScript(
            [join(dir, "intentic-command-guard.mjs"), "edited"],
            JSON.stringify({ conversation_id: "agent-1", file_path: file, edits: [{ old_string: "", new_string: `Client: ${TOKEN}` }] }),
        );
        expect(out.stdout).toBe("");
        expect(readFileSync(file, "utf8")).toBe(`Client: ${SECRET}\n`);
        // An edit with no token never reaches the daemon at all.
        writeFileSync(file, "plain\n");
        const plain = await runScript([join(dir, "intentic-command-guard.mjs"), "edited"], JSON.stringify({ conversation_id: "agent-1", file_path: file, edits: [{ old_string: "", new_string: "plain" }] }));
        expect(plain.stdout).toBe("");
        expect(readFileSync(file, "utf8")).toBe("plain\n");
    });

    test("a script that cannot reach the daemon lets reads and tool calls through, as for the owner's own run", async () => {
        const { service: hooks, dir } = await started();
        await hooks.close();
        service = undefined;
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: "/x", content: SECRET })).toEqual({ permission: "allow" });
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Shell", tool_input: { command: "ls" } })).toEqual({});
    });
});
