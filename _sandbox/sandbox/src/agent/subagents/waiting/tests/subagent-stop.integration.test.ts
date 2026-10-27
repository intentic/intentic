import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { fileOverrunCommand, noteJobShell, openBackgroundJob } from "../../../tools/jobs/background-jobs.js";
import { subagentWaitServer } from "../subagent-wait.js";

// The `stop` tool over real job dirs (made in the temp dir, hence an integration test); the rest of the server's tools
// are in subagent-wait.test.ts.

// A tool call's text answer, as the server's JSON-RPC reply carries it.
interface Reply {
    readonly id?: number;
    readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

interface Transport {
    start: () => Promise<void>;
    close: () => Promise<void>;
    send: (message: Reply) => Promise<void>;
    onmessage?: (message: unknown) => void;
}

// The SDK's server instance is an MCP Server, whose connect takes any transport of this shape.
const connectable = (value: unknown): value is { connect: (transport: Transport) => Promise<void> } =>
    typeof value === "object" && value !== null && "connect" in value && typeof value.connect === "function";

// Drives the server over its public connect(), as the CLI does.
const connect = async (server: McpSdkServerConfigWithInstance): Promise<(method: string, params: object) => Promise<Reply>> => {
    const pending = new Map<number, (reply: Reply) => void>();
    const transport: Transport = {
        start: async () => undefined,
        close: async () => undefined,
        send: async (message) => {
            if (message.id !== undefined) {
                pending.get(message.id)?.(message);
            }
        },
    };
    const instance: unknown = server.instance;
    if (!connectable(instance)) {
        throw new Error("the SDK's server instance has no connect");
    }
    await instance.connect(transport);
    let next = 0;
    return (method, params) =>
        new Promise((resolve) => {
            next += 1;
            pending.set(next, resolve);
            transport.onmessage?.({ jsonrpc: "2.0", id: next, method, params });
        });
};

// The fields of a stop answer this test reads.
interface StopAnswer {
    readonly ok: boolean;
    readonly outcome: string;
    readonly job?: { readonly id: string; readonly exitCode?: number; readonly running: boolean };
}

// TaskStop refuses an id the CLI does not hold before any hook sees it, and a foreground call filed as a job when it ran past
// its time has only the sandbox's: 170 failed stops from 2026-10-02 to 10-26, each leaving its command running. `stop`
// takes that id and the CLI's alike.
test("stop ends a background job by the sandbox's id or by the CLI's, and says which ids it does not know", async () => {
    const fleet = memoryFleet();
    const call = await connect(subagentWaitServer({ conversationId: "conv-stop", conversations: fleet.conversations, signal: new AbortController().signal }));
    const seed = { conversationId: "conv-stop", profile: {}, conversations: fleet.conversations };
    const ran = mkdtempSync(join(tmpdir(), "intentic-run-"));
    // What tmux-run leaves for a foreground command still running: its own files, and no status yet.
    writeFileSync(join(ran, "cmd"), "npx eslint src\n");
    writeFileSync(join(ran, "out"), "Need to install the following packages\n");
    const overran = fileOverrunCommand(seed, { dir: ran, command: "npx eslint src", session: "agent-s", description: undefined, toolUseId: "tu-over", startedAt: Date.now() });
    const backgrounded = openBackgroundJob(seed, { command: "pnpm dev", session: "agent-s", toolUseId: "tu-bg" });
    if (overran === undefined || backgrounded === undefined) {
        throw new Error("jobs not filed");
    }
    noteJobShell(fleet.conversations, "tu-bg", "bdev1");
    const said = async (target: string): Promise<StopAnswer> =>
        // SAFETY: the stop tool answers one JSON text block of this shape; toMatchObject checks every field read.
        JSON.parse((await call("tools/call", { name: "stop", arguments: { target } })).result?.content?.[0]?.text ?? "null") as StopAnswer;
    // No pane ran either here, so each end is written down on its runner's behalf, with a SIGTERM's code.
    await expect(said(overran.id)).resolves.toMatchObject({ ok: true, outcome: "stopped", job: { id: overran.id, exitCode: 143, running: false } });
    expect(readFileSync(join(ran, "status"), "utf8").trim()).toBe("143");
    await expect(said("bdev1")).resolves.toMatchObject({ ok: true, outcome: "stopped", job: { id: "bdev1", exitCode: 143 } });
    await expect(said(overran.id)).resolves.toMatchObject({ ok: true, outcome: "ended" });
    await expect(said("bnobody")).resolves.toMatchObject({ ok: false, outcome: "unknown" });
    rmSync(ran, { recursive: true, force: true });
    rmSync(backgrounded.dir, { recursive: true, force: true });
});
