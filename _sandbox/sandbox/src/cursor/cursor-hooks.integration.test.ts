import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { CommandGate } from "../guard/command-gate.js";
import { createLogger } from "../logger.js";
import { createCursorHookService, type CursorHookService } from "./cursor-hooks.js";

/* THE COMMAND RULEBOOK ON CURSOR'S RUNTIME, END TO END: the gate script Cursor would spawn, run as a real
 * child process, talking to the real socket, over the real HTTP-over-Unix transport. Stubbing any of that
 * would leave the one part most likely to be wrong untested — this is a protocol between a generated script
 * and a server, and the whole claim behind `rulebook: "hooks"` rests on the round trip working.
 *
 * The one thing NOT exercised here is Cursor itself reading /etc/cursor/hooks.json, which no test in this
 * repository can reach. What is pinned instead is the file's content, so the shape Cursor is promised is the
 * shape it is given. */

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

let service: CursorHookService | undefined;
// The enterprise hooks file is a fixed machine-global path in production. Pointed at a temp file here so the
// suite neither depends on /etc being writable nor leaves a file behind on the machine that ran it.
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

// Run the generated script the way Cursor runs it: a child process, the payload on stdin, the verdict on stdout.
const askGate = async (dir: string, payload: unknown): Promise<unknown> => {
    const child = execFile("node", [join(dir, "intentic-command-gate.mjs")]);
    child.stdin?.end(JSON.stringify(payload));
    const stdout = await new Promise<string>((settle) => {
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", () => settle(out));
    });
    return JSON.parse(stdout);
};

// A gate that refuses everything, with the sentence the model and the user are both supposed to receive.
const denying = (reason: string): CommandGate => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    consult: async function* () {
        return { allow: false, reason };
    },
});
const allowing = (): CommandGate => ({
    enforcing: true,
    // eslint-disable-next-line require-yield
    consult: async function* () {
        return { allow: true };
    },
});

test("a registered turn's denial reaches Cursor as a deny, with the reason in both messages", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: denying("Deleting files needs your approval."), push: () => {} });

    expect(await askGate(dir, { command: "rm -rf build", conversation_id: "agent-1", cwd: "/work" })).toEqual({
        permission: "deny",
        // Both, and deliberately the same sentence: one is what the model reads so it can choose something
        // else, the other is what the person sees.
        agent_message: "Deleting files needs your approval.",
        user_message: "Deleting files needs your approval.",
    });
});

test("an allowed command comes back as a bare allow", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    expect(await askGate(dir, { command: "ls", conversation_id: "agent-1" })).toEqual({ permission: "allow" });
});

/* THE CASE THAT MUST NOT BLOCK. This hook fires for every command Cursor runs anywhere on the machine,
 * including a cursor-agent the owner started by hand in their own terminal — which is the owner acting
 * directly, and is exactly the case the daemon has no turn registered for. Blocking those would make the
 * sandbox's agent policy break the owner's own work. */
test("a consult from no known turn is allowed rather than refused", async () => {
    const { dir } = await started();
    expect(await askGate(dir, { command: "rm -rf /", conversation_id: "someone-elses-agent" })).toEqual({ permission: "allow" });
});

/* The fallback that is reasoning rather than guessing: with exactly one Cursor turn running, a consult that
 * arrives unlabelled can only have come from it, and answering it correctly beats waving it through. */
test("an unlabelled consult is answered by the only turn running", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: denying("no"), push: () => {} });
    expect(await askGate(dir, { command: "rm -rf build" })).toMatchObject({ permission: "deny" });
});

test("with two turns running there is nothing to reason from, so it allows", async () => {
    const { service: hooks, dir } = await started();
    hooks.register({ conversationId: "agent-1", gate: denying("no"), push: () => {} });
    hooks.register({ conversationId: "agent-2", gate: denying("no"), push: () => {} });
    // A card shown to the WRONG conversation is worse than an unenforced command that gets logged.
    expect(await askGate(dir, { command: "rm -rf build" })).toEqual({ permission: "allow" });
});

// A workspace with no rules and no taint pays nothing, not even the classification: the same short-circuit
// every vendor-gated runtime takes.
test("a turn whose gate enforces nothing short-circuits to allow", async () => {
    const { service: hooks, dir } = await started();
    const gate: CommandGate = {
        enforcing: false,
        // eslint-disable-next-line require-yield
        consult: async function* () {
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

/* THE CARD'S FRAMES REACH THE TURN THAT RAISED THEM. A hold parks inside the gate and yields a permission
 * frame on the way; the hook process is what Cursor is blocked on meanwhile, which is the whole difference
 * between this tier and the weaker "approval" one. */
test("frames the gate yields are pushed to the turn's own stream", async () => {
    const { service: hooks, dir } = await started();
    const pushed: AgentEvent[] = [];
    // The real card shape, not a stand-in: a fabricated one would have type-checked as `AgentEvent` through a
    // cast and then pinned a frame no client can render.
    const card: AgentEvent = { kind: "permission", requestId: "r1", toolName: "Shell", displayName: "Run command", reason: "rule" };
    const gate: CommandGate = {
        enforcing: true,
        consult: async function* () {
            yield card;
            return { allow: true };
        },
    };
    hooks.register({ conversationId: "agent-1", gate, push: (event) => pushed.push(event) });
    await askGate(dir, { command: "ls", conversation_id: "agent-1" });
    expect(pushed).toEqual([card]);
});

// The script answers for itself when it cannot reach anyone, so a socket that has gone away costs a turn
// nothing. `failClosed` in the hooks file covers the case this cannot: the script being unrunnable at all.
test("a script that cannot reach the daemon allows rather than hanging", async () => {
    const { service: hooks, dir } = await started();
    await hooks.close();
    service = undefined;
    expect(await askGate(dir, { command: "ls", conversation_id: "agent-1" })).toEqual({ permission: "allow" });
});

test("a payload that is not JSON is allowed rather than crashing the turn", async () => {
    const { dir } = await started();
    const child = execFile("node", [join(dir, "intentic-command-gate.mjs")]);
    child.stdin?.end("not json at all");
    const out = await new Promise<string>((settle) => {
        let text = "";
        child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
        child.on("close", () => settle(text));
    });
    expect(JSON.parse(out)).toEqual({ permission: "allow" });
});

/* The one half no test here can drive: Cursor reading the file. So the file's CONTENT is pinned instead —
 * the schema version, the single event wired, and failClosed, which is the guard for a script that cannot
 * run at all. */
test("the hooks file promises exactly the shape Cursor is documented to read", async () => {
    const { dir } = await started();
    const script = join(dir, "intentic-command-gate.mjs");
    expect(readFileSync(script, "utf8")).toContain("permission");
    const installed = readFileSync(hooksFile, "utf8").trim();
    const parsed = JSON.parse(installed) as { version: number; hooks: Record<string, { command: string; failClosed?: boolean }[]> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.hooks)).toEqual(["beforeShellExecution"]);
    expect(parsed.hooks["beforeShellExecution"]?.[0]?.failClosed).toBe(true);
    expect(parsed.hooks["beforeShellExecution"]?.[0]?.command).toContain(script);
});

test("restarting over a socket a dead daemon left behind still binds", async () => {
    const { service: hooks, dir } = await started();
    // A hard kill leaves the socket file on disk, and listen() would fail EADDRINUSE on it forever. Removing
    // it on start is the only way the gate ever comes back.
    hooks.register({ conversationId: "agent-1", gate: allowing(), push: () => {} });
    const second = createCursorHookService(dir, logger);
    await expect(second.start()).resolves.toBeUndefined();
    await second.close();
    await exec("true");
});
