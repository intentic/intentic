import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SendOptions } from "@cursor/sdk";
import { HISTORY_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import type { Logger } from "pino";
import { createTurnIsolation, startAnchor } from "../../conversations/worktrees/isolation.js";
import { type CursorHost, type CursorRuntimeSpawn, namespacedHost, runtimeCommand } from "./cursor-host.js";
import type { CodedError } from "./cursor-runtime-protocol.js";

// The real runtime process (cursor-agent-runtime.ts) under node, driving a stand-in SDK module that reports what the
// process it runs in sees: its cwd, a marker file under the cwd, the tool answer it got back from the daemon. The
// namespace cases start a real anchor and enter it through nsenter, as a turn does.

const logger = unstubbed<Logger>("logger", { debug: () => {}, warn: () => {} });

// A stand-in for @cursor/sdk: the same exports the adapter and the runtime reach, and an agent whose one send calls the
// daemon's custom tool and deltas back everything the test asserts on.
const FAKE_SDK = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
export class RateLimitError extends Error {}
export class AuthenticationError extends Error {}
export class AgentBusyError extends Error {}
export class AgentNotFoundError extends Error {}
export class NetworkError extends Error {}
export class UnknownAgentError extends Error {}
const marker = (dir) => { try { return readFileSync(join(dir, "marker"), "utf8"); } catch { return null; } };
const agent = (options) => ({
    agentId: "agent-1",
    send: async (prompt, sendOptions) => {
        const tool = await options.local.customTools.echo.execute({ said: prompt }, { toolCallId: "call-1" });
        const seen = { cwd: process.cwd(), marker: marker(options.local.cwd), tool, mode: sendOptions.mode, force: sendOptions.local?.force ?? false };
        await sendOptions.onDelta({ update: { type: "text-delta", text: JSON.stringify(seen) } });
        return { wait: async () => ({ id: "run-1", status: "finished" }), cancel: async () => {}, steer: async () => "complete_delivered" };
    },
    close: () => {},
});
export const Agent = {
    create: async (options) => agent(options),
    resume: async (agentId) => { throw new AgentNotFoundError("no agent " + agentId + " on this machine"); },
};
`;

// Written and loaded once, at module scope, so no test pays for the import on its own clock. The daemon's side of the
// channel reads only the error classes off it.
const scratch = mkdtempSync(join(tmpdir(), "cursor-host-"));
const sdkEntry = join(scratch, "fake-sdk.mjs");
writeFileSync(sdkEntry, FAKE_SDK);
const sdk: Pick<typeof import("@cursor/sdk"), CodedError> = await import(pathToFileURL(sdkEntry).href);
afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

// Node, not the suite's own bun, runs the runtime, as node runs the daemon.
const command = { file: "node", args: runtimeCommand().args };

// What the nsenter argv would have run, run directly: the channel and the runtime without the namespace.
const withoutNamespace: CursorRuntimeSpawn = (_command, args) => {
    const [program = "", ...rest] = args.slice(args.indexOf("--") + 1);
    return spawn(program, rest, { cwd: scratch, stdio: ["ignore", "pipe", "pipe", "ipc"] });
};

const echoTool = { echo: { description: "Echoes", execute: (args: Record<string, unknown>) => `echo:${String(args["said"])}` } };

// One turn through a host: open, send, the delta it streamed, the run's result.
const turn = async (host: CursorHost, cwd: string): Promise<{ seen: Record<string, unknown>; status: string }> => {
    const agent = await host(undefined, { apiKey: "key", local: { cwd, customTools: echoTool } });
    const texts: string[] = [];
    const options: SendOptions = {
        mode: "agent",
        local: { force: true },
        onDelta: ({ update }) => {
            if (update.type === "text-delta") {
                texts.push(update.text);
            }
        },
    };
    try {
        const run = await agent.send("hello", options);
        const result = await run.wait();
        expect(await run.steer?.("and this")).toBe("complete_delivered");
        const seen: Record<string, unknown> = JSON.parse(texts[0] ?? "{}");
        return { seen, status: result.status };
    } finally {
        agent.close();
    }
};

test("a turn crosses the channel whole: options out, the daemon's tool answered, the delta and the result back", async () => {
    const host = namespacedHost({ namespace: { pid: 1, cwd: scratch }, sdk, sdkEntry, spawnDepth: 0, logger, spawn: withoutNamespace, command });
    const { seen, status } = await turn(host, scratch);
    expect(status).toBe("finished");
    expect(seen).toMatchObject({ tool: "echo:hello", mode: "agent", force: true });
});

test("an error the SDK throws in the runtime reaches the daemon as an instance of the same SDK class", async () => {
    const host = namespacedHost({ namespace: { pid: 1, cwd: scratch }, sdk, sdkEntry, spawnDepth: 0, logger, spawn: withoutNamespace, command });
    const refused = await host("agent-gone", { apiKey: "key", local: { cwd: scratch } }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(sdk.AgentNotFoundError);
    expect(refused).toMatchObject({ message: "no agent agent-gone on this machine" });
});

test("a runtime that cannot start fails the turn with what it said, rather than hanging it", async () => {
    const host = namespacedHost({
        namespace: { pid: 1, cwd: scratch },
        sdk,
        sdkEntry: join(scratch, "no-such-sdk.mjs"),
        spawnDepth: 0,
        logger,
        spawn: withoutNamespace,
        command,
    });
    await expect(host(undefined, { apiKey: "key", local: { cwd: scratch } })).rejects.toThrow(/no-such-sdk/);
});

const namespace = requires(
    existsSync(HISTORY_ROOT) && spawnSync("unshare", ["--mount", "--propagation", "private", "true"], { timeout: 10_000 }).status === 0,
    `CAP_SYS_ADMIN (unshare --mount) and the history volume at ${HISTORY_ROOT}`,
    // CI's verify-machine job runs it, in a privileged container with a tmpfs at /history (ci.yml).
    { lane: "machine" },
);

test.skipIf(!namespace.runs)(namespace.title("an anchored Cursor turn's SDK runs at the workspace root, and that root is its own worktree"), async () => {
    const base = await mkdtemp(join(HISTORY_ROOT, ".cursor-host-"));
    const root = join(base, "work");
    const history = join(base, "history");
    const worktree = join(history, "worktrees", "conv-1");
    await mkdir(root, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, "marker"), "the owner's checkout");
    await writeFile(join(worktree, "marker"), "the conversation's worktree");
    const plan = await createTurnIsolation({ root, historyRoot: history, logger }).planFor(worktree, undefined);
    const anchor = await startAnchor(plan);
    try {
        // The anchor's own cwd, the root as the namespace names it, is what stream-agent.ts makes the request's cwd.
        const host = namespacedHost({ namespace: { pid: anchor.pid, cwd: anchor.cwd }, sdk, sdkEntry, spawnDepth: 0, logger, command });
        const { seen } = await turn(host, anchor.cwd);
        expect(seen).toMatchObject({ cwd: root, marker: "the conversation's worktree", tool: "echo:hello" });
    } finally {
        anchor.dispose();
        await rm(base, { recursive: true, force: true });
    }
});
