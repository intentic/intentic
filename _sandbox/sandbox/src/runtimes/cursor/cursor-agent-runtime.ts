import { pathToFileURL } from "node:url";
import type * as CursorSdk from "@cursor/sdk";
import type { Run, SDKAgent, SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { errorMessage } from "@intentic/base/errors";
import { opt } from "../../opt.js";
import { CODED_ERRORS, type CallResult, type HostCall, type HostMessage, type RuntimeMessage, type SteerOutcome, type WireTool } from "./cursor-runtime-protocol.js";

// The Cursor SDK's own process for a turn that runs in a mount namespace. @cursor/sdk spawns its shell and edits files
// in whatever process loads it, and offers no seam to move either, so an isolated turn loads it HERE, in a process
// cursor-host.ts starts through nsenter: its cwd and every absolute /work path are the turn's worktree, as they are for
// the Claude CLI and the Codex app-server. The daemon keeps everything else (the custom tools, the hook gate, the
// frames), and this process only drives the SDK, over the IPC channel it was started with.
//
// argv[2] is the SDK entry the daemon resolved (the engine store or the pack); empty means this package's own
// dependency, a dev checkout.

type Sdk = typeof CursorSdk;
type SteerableRun = Run & { readonly steer?: (text: string) => Promise<SteerOutcome> };

const entry = process.argv[2];
const sdkReady: Promise<Sdk> = entry !== undefined && entry !== "" ? import(pathToFileURL(entry).href) : import("@cursor/sdk");

const post = (message: RuntimeMessage): void => {
    // The channel is gone only when the daemon is, and the disconnect handler below ends this process then.
    if (process.connected) {
        process.send?.(message);
    }
};

// A custom tool as the SDK sees it here: same description and schema, executed by the daemon, which answers with a
// tool-reply carrying the same call number.
const toolCalls = new Map<number, { readonly resolve: (value: SDKCustomToolResult) => void; readonly reject: (error: Error) => void }>();
let nextToolCall = 0;
const remoteTool = ({ name, ...advertised }: WireTool): SDKCustomTool => ({
    ...advertised,
    execute: (args, context) =>
        new Promise<SDKCustomToolResult>((resolve, reject) => {
            const call = nextToolCall++;
            toolCalls.set(call, { resolve, reject });
            post({ kind: "tool", call, name, args, ...opt("toolCallId", context.toolCallId) });
        }),
});

let agent: SDKAgent | undefined;
const runs = new Map<number, SteerableRun>();

const live = (): SDKAgent => {
    if (agent === undefined) {
        throw new Error("The Cursor runtime was sent a call before its agent was opened.");
    }
    return agent;
};

const runOf = (run: number): SteerableRun => {
    const handle = runs.get(run);
    if (handle === undefined) {
        throw new Error(`The Cursor runtime has no run ${String(run)}.`);
    }
    return handle;
};

const handle = async (call: HostCall): Promise<CallResult> => {
    switch (call.method) {
        case "open": {
            const sdk = await sdkReady;
            const customTools = Object.fromEntries(call.tools.map((tool) => [tool.name, remoteTool(tool)]));
            const options = { ...call.options, local: { ...call.options.local, customTools } };
            agent = call.resume !== undefined ? await sdk.Agent.resume(call.resume, options) : await sdk.Agent.create(options);
            return { agentId: agent.agentId };
        }
        case "send": {
            const run: SteerableRun = await live().send(call.prompt, {
                ...call.options,
                onDelta: ({ update }) => post({ kind: "delta", run: call.run, update }),
            });
            runs.set(call.run, run);
            return { steerable: run.steer !== undefined };
        }
        case "wait": {
            const result = await runOf(call.run).wait();
            return { status: result.status, ...opt("error", result.error === undefined ? undefined : { message: result.error.message }) };
        }
        case "cancel":
            await runOf(call.run).cancel();
            return null;
        case "steer":
            return (await runOf(call.run).steer?.(call.text)) ?? null;
        case "close":
            agent?.close();
            agent = undefined;
            return null;
    }
};

// One call answered: its result, or the error as its message and the SDK class the daemon rebuilds it as.
const answer = async (seq: number, call: HostCall): Promise<void> => {
    try {
        post({ kind: "reply", seq, ok: true, value: await handle(call) });
    } catch (error) {
        const sdk = await sdkReady.catch(() => undefined);
        const coded = sdk === undefined ? undefined : CODED_ERRORS.find((name) => error instanceof sdk[name]);
        post({ kind: "reply", seq, ok: false, error: { message: errorMessage(error), ...opt("coded", coded) } });
    }
};

process.on("message", (message: HostMessage) => {
    if (message.kind === "tool-reply") {
        const waiter = toolCalls.get(message.call);
        toolCalls.delete(message.call);
        if (message.ok) {
            waiter?.resolve(message.value);
        } else {
            waiter?.reject(new Error(message.message));
        }
        return;
    }
    void answer(message.seq, message.call);
});

// The daemon closed the channel (the turn ended) or died. The SDK may still be settling its local store, so the loop is
// let drain on its own, and cut off only if something it holds would keep it alive past the grace.
const EXIT_GRACE_MS = 3_000;
process.on("disconnect", () => {
    setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref();
});

// The SDK ran inside the daemon before this process existed, where a stray rejection was logged rather than fatal; a
// turn here keeps that, so one stray promise does not end the run it came from.
process.on("unhandledRejection", console.error.bind(console, "cursor runtime: unhandled rejection:"));
