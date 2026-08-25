import { type HostScopes, type MachineFlowLine, type MachineSandboxFlow, hostContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";
import { manageSandbox, removeSandbox, runnerFlow, swapSandbox, tailSandboxLogs } from "./tools/sandboxes.js";

/* What this computer answers, as the oRPC SERVER on the socket it dialled out.
 *
 * The inversion is the interesting part: the machine placed the call, and the machine is also the one being
 * asked. That works because oRPC's websocket adapter attaches a handler to any socket-like object, so which peer
 * dialled is independent of which peer serves.
 *
 * `scopes` is a live reference, not a copy: `setScopes` replaces what the whole agent enforces, and the MCP
 * handler reads it per call, so a switch the owner turns off is in force on the very next tool call rather than
 * at the next reconnect. */
export interface HostRuntime {
    readonly scopes: () => HostScopes;
    readonly setScopes: (scopes: HostScopes) => void;
    readonly log: (message: string) => void;
}

/* A flow that reports through a callback, turned into the stream the browser reads.
 *
 * The flow functions take an `onLine` because their OTHER caller is an MCP tool, which wants one answer at the
 * end and has no use for a line as it arrives. This adapts those same calls rather than adding a second
 * implementation of any of them, so what a person watches and what the agent is told can never describe the
 * same run differently.
 *
 * Lines are queued rather than dropped when the consumer is slower than the machine: an image pull prints
 * faster than a WebSocket drains, and a progress log with holes in it is worse than one that lags. */
async function* streamFlow(run: (onLine: (line: string) => void) => Promise<string>): AsyncGenerator<MachineFlowLine> {
    const queued: string[] = [];
    let wake: (() => void) | undefined;
    const nudge = (): void => {
        const pending = wake;
        wake = undefined;
        pending?.();
    };
    let settled: { readonly ok: boolean; readonly message: string } | undefined;
    // Started here rather than awaited, so the loop below can yield what it prints while it is still running.
    // The rejection is captured as a value: it is this stream's terminal frame, not this generator's failure.
    const finished = run((line) => {
        queued.push(line);
        nudge();
    })
        .then((message) => ({ ok: true, message }))
        .catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }))
        .then((outcome) => {
            settled = outcome;
            nudge();
        });

    for (;;) {
        const next = queued.shift();
        if (next !== undefined) {
            yield { kind: "line", text: next };
            continue;
        }
        // Drained AND finished, every line the flow produced has been sent, so the terminal frame is next.
        if (settled !== undefined) {
            break;
        }
        await new Promise<void>((resolve) => {
            wake = resolve;
        });
    }
    await finished;
    yield settled?.ok === true
        ? { kind: "result", message: settled.message }
        : { kind: "error", message: settled?.message ?? "The operation stopped without saying why." };
}

// Which function each op is. Start/stop/restart are a docker call and say one sentence, `logs` is a read whose
// lines ARE the answer, and the rest run `ic` and narrate themselves for minutes. One switch so the machine has a
// single answer to "what does this op mean".
const flowFor = ({ op, slug, hash, parentUrl, pair }: MachineSandboxFlow, scopes: HostScopes): ((onLine: (line: string) => void) => Promise<string>) => {
    switch (op) {
        case "remove":
            return (onLine) => removeSandbox(slug, scopes, onLine);
        // A container that belongs to the asking sandbox rather than to a person; `slug` is the runner's name.
        case "runner-up":
        case "runner-remove":
            return (onLine) => runnerFlow(op, slug, parentUrl, pair, scopes, onLine);
        case "logs":
            return (onLine) => tailSandboxLogs(slug, scopes, onLine);
        case "prepare":
        case "update":
        case "rebuild":
        case "rollback":
            return (onLine) => swapSandbox(op, slug, hash, scopes, onLine);
        default:
            return async () => await manageSandbox(op, slug, scopes);
    }
};

export const createHostRouter = (runtime: HostRuntime) => {
    const os = implement(hostContract);
    return os.router({
        describe: os.describe.handler(async () => await hostFacts(runtime.scopes())),
        setScopes: os.setScopes.handler(({ input }) => {
            runtime.setScopes(input);
            runtime.log(`permissions updated: commands ${input.shell}, writes ${input.write}, screen ${input.screen}`);
            // Caching it on disk belongs to whoever knows WHICH sandbox pushed, which is the connection and not
            // this router (see connection.ts): a computer answers to a list of sandboxes now, each with its own
            // grant, and a writer that could not name the link would have to guess which one to overwrite.
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure. Its payload is MCP, understood by handleMcpMessage and by the tool it names,
        // not by this contract, and deliberately not by the daemon (see the contract for why).
        mcp: os.mcp.handler(async ({ input }) => await handleMcpMessage(input, runtime.scopes)),
        // The scopes are read HERE, per call, exactly as the MCP handler reads them, a stream opened before the
        // owner flipped a switch must not outlive the decision.
        runSandboxFlow: os.runSandboxFlow.handler(({ input }) => streamFlow(flowFor(input, runtime.scopes()))),
    });
};
