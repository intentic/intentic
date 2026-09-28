import type { Readable } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as CursorSdk from "@cursor/sdk";
import type { AgentOptions, SDKCustomTool, SendOptions } from "@cursor/sdk";
import type { Logger } from "pino";
import { errorMessage } from "@intentic/base/errors";
import { opt } from "../../opt.js";
import { nsenterArgv } from "../../workload/namespace-entry.js";
import { spawnAs } from "../../workload/workload-class.js";
import type {
    CodedError,
    CallMethod,
    CallResult,
    CallResults,
    HostCall,
    HostMessage,
    RuntimeMessage,
    SteerOutcome,
    WireError,
    WireRunResult,
    WireTool,
} from "./cursor-runtime-protocol.js";

// Where a Cursor turn's SDK agent lives. A turn with no namespace of its own (the main tree, or a container that cannot
// build a mount namespace) runs it in this process, as it always has. A namespaced one runs it in a Node process born in
// the turn's namespace (cursor-agent-runtime.ts), the way the Claude CLI and the Codex app-server are: @cursor/sdk
// spawns its shell and edits files in the process that loads it, so in the daemon an absolute /work path named the
// owner's checkout. The adapter sees one narrow session either way.

type Sdk = typeof CursorSdk;
// All of the SDK the daemon's side of the channel needs: the classes an error is rebuilt as.
type SdkErrors = Pick<Sdk, CodedError>;

// The slice of a Run the adapter uses. `steer` is optional: an SDK without it simply has no mid-run injection.
export interface CursorRunHandle {
    readonly wait: () => Promise<WireRunResult>;
    readonly cancel: () => Promise<void>;
    readonly steer?: (text: string) => Promise<SteerOutcome>;
}

// The slice of an SDKAgent the adapter uses; the in-process SDKAgent is one as it stands.
export interface CursorSession {
    readonly agentId: string;
    readonly send: (prompt: string, options: SendOptions) => Promise<CursorRunHandle>;
    readonly close: () => void;
}

// Opens the turn's agent: resumes the named session, or creates one when there is none.
export type CursorHost = (resume: string | undefined, options: AgentOptions) => Promise<CursorSession>;

export const inProcessHost =
    (sdk: Sdk): CursorHost =>
    (resume, options) =>
        resume !== undefined ? sdk.Agent.resume(resume, options) : sdk.Agent.create(options);

// The members of the runtime's ChildProcess the channel reaches, which is all a suite's stand-in has to be.
export interface RuntimeProcess {
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    readonly connected: boolean;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    send(message: HostMessage, callback: (error: Error | null) => void): boolean;
    disconnect(): void;
    kill(signal: NodeJS.Signals): boolean;
    on(event: "message", listener: (message: RuntimeMessage) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

// Starts the runtime process from a finished argv; a seam so a suite can stand in for the process.
export type CursorRuntimeSpawn = (command: string, args: readonly string[], spawnDepth: number) => RuntimeProcess;

const spawnRuntime: CursorRuntimeSpawn = (command, args, spawnDepth) =>
    spawnAs({ class: "agentRuntime", spawnDepth }, command, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });

// The runtime entry beside this file, so dev and dist take the same path (.ts under tsx, .js under node), absolute so
// no cwd changes which one runs. Its name carries "agent-runtime", which is how the process scan files it.
export const runtimeCommand = (): { readonly file: string; readonly args: readonly string[] } => {
    const dev = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(dev ? "./cursor-agent-runtime.ts" : "./cursor-agent-runtime.js", import.meta.url));
    return dev ? { file: process.execPath, args: ["--import", createRequire(import.meta.url).resolve("tsx"), entry] } : { file: process.execPath, args: [entry] };
};

// How long a closing runtime gets to settle its local store after the close call before it is killed.
const CLOSE_GRACE_MS = 10_000;

// An error that crossed as its message and class, made an instance of the same SDK class again so the adapter's
// codedError reads it exactly as it reads one thrown in this process.
const rebuilt = (error: WireError, sdk: SdkErrors): Error => {
    const rebuiltError = new Error(error.message);
    if (error.coded !== undefined) {
        Object.setPrototypeOf(rebuiltError, sdk[error.coded].prototype);
    }
    return rebuiltError;
};

const wireTools = (tools: Record<string, SDKCustomTool>): WireTool[] =>
    Object.entries(tools).map(([name, { execute: _execute, ...advertised }]) => ({ name, ...advertised }));

interface RuntimeChannel {
    readonly call: <M extends CallMethod>(call: Extract<HostCall, { method: M }>) => Promise<CallResults[M]>;
    readonly onDelta: (run: number, listener: SendOptions["onDelta"]) => void;
    readonly close: () => void;
}

const runtimeChannel = (child: RuntimeProcess, tools: Record<string, SDKCustomTool>, sdk: SdkErrors, logger: Logger): RuntimeChannel => {
    const pending = new Map<number, { readonly resolve: (value: CallResult) => void; readonly reject: (error: Error) => void }>();
    const deltas = new Map<number, NonNullable<SendOptions["onDelta"]>>();
    let seq = 0;
    let failure: Error | undefined;
    let output = "";

    const collect = (chunk: Buffer | string): void => {
        output = (output + chunk.toString()).slice(-4_096);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const fail = (error: Error): void => {
        failure ??= error;
        for (const waiter of pending.values()) {
            waiter.reject(error);
        }
        pending.clear();
    };
    child.once("error", fail);
    child.once("exit", (code, signal) => {
        const detail = output.trim();
        fail(new Error(`The Cursor runtime process exited (${signal ?? code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`));
    });

    // A send the channel refuses means the process is gone; its exit is what fails the calls still waiting.
    const write = (message: HostMessage): void => {
        try {
            child.send(message, (error: Error | null) => {
                if (error !== null) {
                    logger.debug({ err: error }, "cursor runtime: message not delivered");
                }
            });
        } catch (error) {
            logger.debug({ err: error }, "cursor runtime: channel closed");
        }
    };

    // Custom tools run here, where the daemon's cards, children and gate are; the runtime only relays the call.
    const runTool = async (message: Extract<RuntimeMessage, { kind: "tool" }>): Promise<void> => {
        const tool = tools[message.name];
        try {
            if (tool === undefined) {
                throw new Error(`No tool named ${message.name} was given to this turn.`);
            }
            const value = await tool.execute(message.args, message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {});
            write({ kind: "tool-reply", call: message.call, ok: true, value });
        } catch (error) {
            write({ kind: "tool-reply", call: message.call, ok: false, message: errorMessage(error) });
        }
    };

    child.on("message", (message: RuntimeMessage) => {
        switch (message.kind) {
            case "reply": {
                const waiter = pending.get(message.seq);
                pending.delete(message.seq);
                if (message.ok) {
                    waiter?.resolve(message.value);
                } else {
                    waiter?.reject(rebuilt(message.error, sdk));
                }
                return;
            }
            case "delta":
                void deltas.get(message.run)?.({ update: message.update });
                return;
            case "tool":
                void runTool(message);
                return;
        }
    });

    const call = <M extends CallMethod>(hostCall: Extract<HostCall, { method: M }>): Promise<CallResults[M]> => {
        if (failure !== undefined) {
            return Promise.reject(failure);
        }
        return new Promise<CallResults[M]>((resolve, reject) => {
            const id = seq++;
            // SAFETY: the reply carrying this seq is the runtime's answer to this call, and its `handle` answers each
            // method with that method's own entry in CallResults.
            pending.set(id, { resolve: (value) => resolve(value as CallResults[M]), reject });
            write({ kind: "call", seq: id, call: hostCall });
        });
    };

    const running = (): boolean => child.exitCode === null && child.signalCode === null;

    return {
        call,
        onDelta: (run, listener) => {
            if (listener !== undefined) {
                deltas.set(run, listener);
            }
        },
        // The agent is closed in the runtime first, then the channel, which lets the runtime exit on its own; the kill
        // is for a runtime that does not.
        close: () => {
            void call({ method: "close" })
                .catch((error) => logger.debug({ err: error }, "cursor runtime: the agent did not close, disconnecting it anyway"))
                .finally(() => {
                    if (child.connected) {
                        child.disconnect();
                    }
                    if (!running()) {
                        return;
                    }
                    const kill = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
                    kill.unref();
                    child.once("exit", () => clearTimeout(kill));
                });
        },
    };
};

const remoteSession = (channel: RuntimeChannel, agentId: string): CursorSession => {
    let nextRun = 0;
    return {
        agentId,
        send: async (prompt, options) => {
            const { onDelta, onStep: _onStep, ...wire } = options;
            const run = nextRun++;
            // Registered before the call: deltas can arrive ahead of send's own reply, as they do in process.
            channel.onDelta(run, onDelta);
            const { steerable } = await channel.call({ method: "send", run, prompt, options: wire });
            const steer = async (text: string): Promise<SteerOutcome> => (await channel.call({ method: "steer", run, text })) ?? "revert_to_followup";
            return {
                wait: () => channel.call({ method: "wait", run }),
                cancel: async () => {
                    await channel.call({ method: "cancel", run });
                },
                ...opt("steer", steerable ? steer : undefined),
            };
        },
        close: channel.close,
    };
};

export interface NamespacedHostInput {
    // The turn's namespace anchor: its pid, and the root as the namespace sees it (/work, which is the worktree there).
    readonly namespace: { readonly pid: number; readonly cwd: string };
    readonly sdk: SdkErrors;
    // The SDK entry this daemon resolved, loaded by the runtime too, so both processes run one copy; undefined is this
    // package's own dependency.
    readonly sdkEntry: string | undefined;
    readonly spawnDepth: number;
    readonly logger: Logger;
    readonly spawn?: CursorRuntimeSpawn;
    readonly command?: { readonly file: string; readonly args: readonly string[] };
}

export const namespacedHost =
    (input: NamespacedHostInput): CursorHost =>
    async (resume, options) => {
        const { local, ...rest } = options;
        const { customTools = {}, store: _store, ...localWire } = local ?? {};
        const command = input.command ?? runtimeCommand();
        // nsenter execs the runtime into the anchor's namespace and stays a direct child; --wdns makes its cwd /work as
        // the namespace sees it, before the SDK is even loaded.
        const argv = nsenterArgv(input.namespace.pid, input.namespace.cwd, command.file, [...command.args, input.sdkEntry ?? ""]);
        const child = (input.spawn ?? spawnRuntime)(argv.command, argv.args, input.spawnDepth);
        const channel = runtimeChannel(child, customTools, input.sdk, input.logger);
        try {
            const opened = await channel.call({
                method: "open",
                resume,
                options: { ...rest, ...opt("local", local === undefined ? undefined : localWire) },
                tools: wireTools(customTools),
            });
            return remoteSession(channel, opened.agentId);
        } catch (error) {
            channel.close();
            throw error;
        }
    };
