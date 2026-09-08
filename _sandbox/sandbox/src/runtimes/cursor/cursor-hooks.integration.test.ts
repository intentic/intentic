import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CommandGate } from "../../guard/command-gate.js";
import { createLogger } from "../../logger.js";
import { createCursorHookService, type CursorHookService } from "./cursor-hooks.js";

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
const askHook = async (dir: string, mode: "gate" | "session-env", payload: unknown): Promise<unknown> => {
    const child = execFile("node", [join(dir, "intentic-command-gate.mjs"), mode]);
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

// A gate that denies every command with the given reason.
const denying = (reason: string): CommandGate => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    async *consult() {
        return { allow: false, reason };
    },
});
const allowing = (): CommandGate => ({
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
    const gate: CommandGate = {
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
    const gate: CommandGate = {
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
});

test("a payload that is not JSON is allowed rather than crashing the turn", async () => {
    const { dir } = await started();
    const child = execFile("node", [join(dir, "intentic-command-gate.mjs"), "gate"]);
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
    const script = join(dir, "intentic-command-gate.mjs");
    expect(readFileSync(script, "utf8")).toContain("permission");
    const installed = readFileSync(hooksFile, "utf8").trim();
    const parsed = JSON.parse(installed) as { version: number; hooks: Record<string, { command: string; failClosed?: boolean }[]> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.hooks)).toEqual(["sessionStart", "beforeShellExecution"]);
    expect(parsed.hooks["sessionStart"]?.[0]?.failClosed).toBe(false);
    expect(parsed.hooks["sessionStart"]?.[0]?.command).toBe(`node ${JSON.stringify(script)} session-env`);
    expect(parsed.hooks["beforeShellExecution"]?.[0]?.failClosed).toBe(true);
    expect(parsed.hooks["beforeShellExecution"]?.[0]?.command).toBe(`node ${JSON.stringify(script)} gate`);
});

test("restarting over a socket a dead daemon left behind still binds", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    const second = createCursorHookService(dir, logger);
    await expect(second.start()).resolves.toBeUndefined();
    await second.close();
    await exec("true");
});
