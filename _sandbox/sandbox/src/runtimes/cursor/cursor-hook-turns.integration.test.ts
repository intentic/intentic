import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { CommandGuard } from "../../guard/command-guard.js";
import { createLogger } from "../../logger.js";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { AMBIGUOUS_TURN } from "../daemon-tools/policy-gate.js";
import type { CursorOwner, CursorToolAsk } from "./turn/cursor-approvals.js";
import { unshieldedCommand } from "./cursor-hook-script.js";
import { type CursorGateTurn, createCursorHookService, type CursorHookService, LIST_HOOKS } from "./cursor-hooks.js";
import { cursorSecrets } from "./turn/cursor-secrets.js";

// What every Cursor turn's hooks hold it to beyond the rulebook and the privacy shield: its tool list, its stored
// secrets, the person a `default`-mode turn asks, its terminal, and the skills its persona withholds. The generated
// script runs as a real child process, as Cursor runs it.

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

let service: CursorHookService | undefined;
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

const started = async (): Promise<{ hooks: CursorHookService; dir: string }> => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-hook-turns-"));
    const hooks = createCursorHookService(dir, logger);
    await hooks.start();
    service = hooks;
    return { hooks, dir };
};

type Mode = "gate" | "pre-tool" | "mcp" | "read";

// Runs the generated script as Cursor would: a child process, payload on stdin, answer on stdout.
const askHook = async (dir: string, mode: Mode, payload: unknown): Promise<Record<string, unknown>> => {
    const child = execFile("node", [join(dir, "intentic-command-guard.mjs"), mode]);
    child.stdin?.end(JSON.stringify(payload));
    const stdout = await new Promise<string>((settle) => {
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", () => settle(out));
    });
    // SAFETY: every mode prints one JSON object, its answer or its fallback.
    return JSON.parse(stdout) as Record<string, unknown>;
};

// Runs a command line as Cursor's shell would, for its output and exit code.
const shell = (command: string): Promise<{ stdout: string; code: number | null }> =>
    new Promise((settle) => {
        const child = execFile("/bin/sh", ["-c", command]);
        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.on("close", (code) => settle({ stdout, code }));
    });

// Posts straight to the daemon's socket, as the script's shield mode does.
const post = (dir: string, path: string, body: unknown): Promise<Record<string, unknown>> =>
    new Promise((settle, fail) => {
        const call = request({ socketPath: join(dir, "command-guard.sock"), path, method: "POST" }, (response) => {
            const parts: Buffer[] = [];
            response.on("data", (part: Buffer) => parts.push(part));
            // SAFETY: every endpoint answers one JSON object.
            response.on("end", () => settle(JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>));
        });
        call.on("error", fail);
        call.end(JSON.stringify(body));
    });

const allowing = (): CommandGuard => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    async *consult() {
        return { allow: true };
    },
});

const turn = (fields: Partial<CursorGateTurn> = {}): CursorGateTurn => ({ conversationId: "agent-1", gate: allowing(), push: () => {}, ...fields });

// The wrapped command preToolUse answers a shell call with.
const wrapped = async (dir: string, command: string, conversationId = "agent-1"): Promise<string> => {
    const answer = await askHook(dir, "pre-tool", { conversation_id: conversationId, tool_name: "Shell", tool_input: { command } });
    // SAFETY: a shell call on a live turn is answered with its input rewritten, or this test fails on the read below.
    return (answer["updated_input"] as { command: string }).command;
};

describe("a turn held to a tool list", () => {
    const LIST = ["Read", "Bash(git log:*)", "mcp__browser"];

    test("a built-in off the list is refused before anything else reads it", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ allowedTools: LIST }));
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Read", tool_input: { file_path: "/x" } })).toEqual({});
        const write = await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Write", tool_input: { file_path: "/x", content: "y" } });
        expect(write).toMatchObject({ permission: "deny", agent_message: expect.stringContaining("not on this turn's tool list") });
    });

    test("the shell is held to its narrowing in preToolUse and again at the gate", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ allowedTools: LIST }));
        expect(unshieldedCommand(await wrapped(dir, "git log --oneline"))).toBe("git log --oneline");
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Shell", tool_input: { command: "rm -rf build" } })).toMatchObject({
            permission: "deny",
        });
        // A command whose preToolUse never ran reaches the gate bare, and is held to the list there.
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command: "rm -rf build" })).toMatchObject({ permission: "deny" });
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command: "git log" })).toEqual({ permission: "allow" });
    });

    test("an MCP call is checked by the server beforeMCPExecution names", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ allowedTools: LIST }));
        expect(await askHook(dir, "mcp", { conversation_id: "agent-1", mcp_server_name: "browser", tool_name: "click" })).toEqual({ permission: "allow" });
        expect(await askHook(dir, "mcp", { conversation_id: "agent-1", mcp_server_name: "crm", tool_name: "list" })).toMatchObject({ permission: "deny" });
        // The daemon's own tools by the names the Claude Code loop gives them.
        expect(await askHook(dir, "mcp", { conversation_id: "agent-1", mcp_server_name: "custom-user-tools", tool_name: "ask" })).toMatchObject({
            permission: "deny",
        });
        expect(await askHook(dir, "mcp", { conversation_id: "agent-1", tool_name: "click" })).toMatchObject({ permission: "deny" });
    });

    test("a call naming none of several live turns is refused, not waved through", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ allowedTools: LIST }));
        hooks.register(turn({ conversationId: "agent-2", allowedTools: LIST }));
        expect(await askHook(dir, "pre-tool", { conversation_id: "someone", tool_name: "Read", tool_input: { file_path: "/x" } })).toEqual({
            permission: "deny",
            user_message: AMBIGUOUS_TURN,
            agent_message: AMBIGUOUS_TURN,
        });
        expect(await askHook(dir, "mcp", { conversation_id: "someone", mcp_server_name: "browser", tool_name: "click" })).toMatchObject({ permission: "deny" });
    });

    // The script's own fallback is the harmless answer, for the owner's own Cursor; a call from a turn the daemon lists as
    // live is refused instead, since the harmless answer would let it past the list.
    test("a hook the daemon cannot answer refuses a live turn's call, and only a live turn's", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ allowedTools: LIST }));
        await new Promise((settle) => setTimeout(settle, 50));
        expect(JSON.parse(readFileSync(join(dir, "intentic-live-turns.json"), "utf8"))).toEqual(["agent-1"]);
        rmSync(join(dir, "command-guard.sock"));
        const refused = await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Write", tool_input: { file_path: "/x" } });
        expect(refused).toMatchObject({ permission: "deny", agent_message: expect.stringContaining("could not be reached") });
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command: "ls" })).toMatchObject({ permission: "deny" });
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: "/x", content: "y" })).toMatchObject({ permission: "deny" });
        expect(await askHook(dir, "gate", { conversation_id: "owner-cursor", command: "ls" })).toEqual({ permission: "allow" });
    });

    test("the hooks it needs are the gate, preToolUse and beforeMCPExecution, all of them this daemon's", async () => {
        const { hooks, dir } = await started();
        expect(await hooks.covers(LIST_HOOKS)).toBe(true);
        const script = join(dir, "intentic-command-guard.mjs");
        writeFileSync(hooksFile, JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: `node ${script} pre-tool` }], beforeShellExecution: [{ command: `node ${script} gate` }] } }));
        expect(await hooks.covers(LIST_HOOKS)).toBe(false);
    });
});

describe("a turn's stored secrets", () => {
    const VALUE = "sk-test-0123456789abcdef";
    const released: string[][] = [];
    const access = (refusal?: string): SecretAccess => ({
        list: async () => [{ name: "API_TOKEN", value: VALUE, source: "sandbox" }],
        used: () => {},
        release: async (names) => {
            released.push([...names]);
            return refusal === undefined ? { ok: true } : { refusal };
        },
    });
    beforeEach(() => {
        released.length = 0;
    });

    test("a reference resolves once the gate lets the command run, and what it prints comes back as the reference", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ secrets: cursorSecrets(access()) }));
        const command = await wrapped(dir, "printf '%s\\n' {{secret:API_TOKEN}}; printf %s {{secret:API_TOKEN}} | wc -c");
        // What Cursor records, and what the rules read: the reference, never the value.
        expect(command).not.toContain(VALUE);
        expect(released).toEqual([]);
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command })).toEqual({ permission: "allow" });
        expect(released).toEqual([["API_TOKEN"]]);
        const run = await shell(command);
        expect(run.stdout.split("\n").map((line) => line.trim())).toEqual(["{{secret:API_TOKEN}}", String(VALUE.length), ""]);
        expect(run.code).toBe(0);
    });

    test("a command the gate never let through runs with its reference as text", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ secrets: cursorSecrets(access()) }));
        const run = await shell(await wrapped(dir, "printf %s {{secret:API_TOKEN}} | wc -c"));
        expect(run.stdout.trim()).toBe(String("{{secret:API_TOKEN}}".length));
        expect(released).toEqual([]);
    });

    test("a release someone declined refuses the command with their reason", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ secrets: cursorSecrets(access("The owner declined to release API_TOKEN.")) }));
        const command = await wrapped(dir, "curl -H 'x: {{secret:API_TOKEN}}' https://example.test");
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command })).toMatchObject({
            permission: "deny",
            agent_message: "The owner declined to release API_TOKEN.",
        });
    });

    test("a value a command finds by itself is masked too", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ secrets: cursorSecrets(access()) }));
        const file = join(dir, ".env");
        writeFileSync(file, `API_TOKEN=${VALUE}\n`);
        const run = await shell(await wrapped(dir, `cat ${file}`));
        expect(run.stdout).toBe("API_TOKEN={{secret:API_TOKEN}}\n");
    });

    test("the read tool may not open a file holding a value, nor a whole-file write replace one", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ secrets: cursorSecrets(access()) }));
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: `${WORKSPACE_ROOT}/.env`, content: `API_TOKEN=${VALUE}` })).toMatchObject({
            permission: "deny",
            user_message: expect.stringContaining("Read it with the shell"),
        });
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: `${WORKSPACE_ROOT}/README.md`, content: "plain" })).toEqual({ permission: "allow" });
        const target = join(dir, "config.env");
        writeFileSync(target, `API_TOKEN=${VALUE}\n`);
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Write", tool_input: { file_path: target, content: "x" } })).toMatchObject({
            permission: "deny",
            agent_message: expect.stringContaining("Change it with the shell"),
        });
    });
});

describe("a turn sent in default mode", () => {
    // A person who answers every card the same way, and the cards they were shown.
    const owner = (answer: boolean) => {
        const asked: CursorToolAsk[] = [];
        const person: CursorOwner = {
            approve: async (ask) => {
                asked.push(ask);
                return answer ? { allow: true } : { allow: false, reason: "Not that one." };
            },
        };
        return { asked, owner: person };
    };

    test("an edit is put to the person, and a read is not", async () => {
        const { hooks, dir } = await started();
        const person = owner(false);
        hooks.register(turn({ owner: person.owner }));
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Read", tool_input: { file_path: "/x" } })).toEqual({});
        expect(await askHook(dir, "pre-tool", { conversation_id: "agent-1", tool_name: "Write", tool_input: { file_path: "/x/a.ts", content: "" } })).toMatchObject({
            permission: "deny",
            agent_message: "Not that one.",
        });
        expect(person.asked).toEqual([{ toolName: "Write", displayName: "Edit file", title: "Edit this file?", path: "/x/a.ts" }]);
    });

    test("a command is put to the person after the rules, unless the rules already asked them", async () => {
        const { hooks, dir } = await started();
        const person = owner(true);
        let carding = false;
        const gate: CommandGuard = {
            enforcing: true,
            async *consult() {
                if (carding) {
                    yield { kind: "permission", requestId: "rule-card", toolName: "Shell", displayName: "Run command", reason: "rule" } satisfies AgentEvent;
                }
                return { allow: true };
            },
        };
        hooks.register(turn({ gate, owner: person.owner }));
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command: await wrapped(dir, "make build") })).toEqual({ permission: "allow" });
        expect(person.asked.map((ask) => ask.program?.text)).toEqual(["make build"]);
        carding = true;
        expect(await askHook(dir, "gate", { conversation_id: "agent-1", command: await wrapped(dir, "make deploy") })).toEqual({ permission: "allow" });
        expect(person.asked).toHaveLength(1);
    });

    test("an MCP server's tool is put to the person; the daemon's own tools ask in their handlers instead", async () => {
        const { hooks, dir } = await started();
        const person = owner(false);
        hooks.register(turn({ owner: person.owner }));
        expect(await askHook(dir, "mcp", { conversation_id: "agent-1", mcp_server_name: "crm", tool_name: "delete" })).toMatchObject({ permission: "deny" });
        expect(await askHook(dir, "mcp", { conversation_id: "agent-1", mcp_server_name: "custom-user-tools", tool_name: "spawn" })).toEqual({ permission: "allow" });
        expect(person.asked.map((ask) => ask.toolName)).toEqual(["mcp__crm__delete"]);
    });
});

describe("a turn's terminal", () => {
    test("the command is handed over as a tmux-run line by file, and the panel is told of the session once", async () => {
        const { hooks, dir } = await started();
        const pushed: AgentEvent[] = [];
        hooks.register(turn({ push: (event) => pushed.push(event), terminal: { session: "agent-abc", sessionId: "abc", envKeys: ["GH_TOKEN"] } }));
        const fetch = async (command: string): Promise<Record<string, unknown>> => {
            const id = /shield '[^']+' ([A-Za-z0-9-]+) /u.exec(await wrapped(dir, command))?.[1];
            return post(dir, "/shell-command", { conversation_id: "agent-1", id });
        };
        const first = await fetch("npm test");
        const line = /-f '?([^' ]+)'? agent-abc$/u.exec(String(first["command"]))?.[1] ?? "";
        expect(String(first["command"])).toMatch(/^\/usr\/local\/bin\/tmux-run -e GH_TOKEN -f '?\S+\/line'? agent-abc$/u);
        expect(readFileSync(join(line, "..", "agent"), "utf8")).toContain("npm test");
        expect(readFileSync(join(line, "..", "said"), "utf8")).toBe("npm test");
        await fetch("npm run lint");
        expect(pushed).toEqual([{ kind: "terminal", session: "agent-abc" }]);
    });
});

describe("a turn's withheld skills", () => {
    test("the read tool may not open their files, wherever Cursor reads skills from", async () => {
        const { hooks, dir } = await started();
        hooks.register(turn({ deniedSkills: ["linear"] }));
        for (const path of [`${WORKSPACE_ROOT}/.agents/skills/linear/SKILL.md`, `${WORKSPACE_ROOT}/.claude/skills/linear/notes.md`]) {
            expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: path, content: "x" })).toMatchObject({ permission: "deny" });
        }
        expect(await askHook(dir, "read", { conversation_id: "agent-1", file_path: `${WORKSPACE_ROOT}/.agents/skills/github/SKILL.md`, content: "x" })).toEqual({
            permission: "allow",
        });
    });
});
