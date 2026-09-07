import { narrate } from "@intentic/base/async";
import { type HostScopes, type DeviceFlowLine, type DeviceSandboxFlow, hostContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";
import { runAgentOp } from "./tools/agent.js";
import { manageSandbox, removeSandbox, reshapeSandbox, runnerFlow, swapSandbox, tailSandboxLogs } from "./tools/sandboxes.js";

/* What this device answers, as the oRPC SERVER on the socket it dialled out.
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

// A flow's callback-reported lines as the stream the browser reads (@intentic/base's `narrate` says why
// the flows report that way and why lines are queued). What is here is only this wire's terminal frame.
const streamFlow = (run: (onLine: (line: string) => void) => Promise<string>): AsyncGenerator<DeviceFlowLine> =>
    narrate(run, (outcome): DeviceFlowLine => (outcome.ok ? { kind: "result", message: outcome.value } : { kind: "error", message: outcome.error }));

// Which function each op is. Start/stop/restart are a docker call and say one sentence, `logs` is a read whose
// lines ARE the answer, and the rest run `ic` and narrate themselves for minutes. One switch so the machine has a
// single answer to "what does this op mean".
const flowFor = (
    { op, slug, hash, resources, parentUrl, pair, definition, overlay, overlayHash }: DeviceSandboxFlow,
    scopes: HostScopes,
): ((onLine: (line: string) => void) => Promise<string>) => {
    switch (op) {
        case "remove":
            return (onLine) => removeSandbox(slug, scopes, onLine);
        // The same image with a different share of this machine: the one op with a payload of its own.
        case "reshape":
            return (onLine) => reshapeSandbox(slug, resources, scopes, onLine);
        // A container that belongs to the asking sandbox rather than to a person; `slug` is the runner's name.
        // The parent's shape (a settings definition, its approved overlay + pinning hash) rides to `ic` as
        // files, so the runner starts as the asking sandbox's twin instead of a bare base image.
        case "runner-up":
        case "runner-remove":
            return (onLine) =>
                runnerFlow(
                    op,
                    slug,
                    parentUrl,
                    pair,
                    {
                        ...(definition !== undefined ? { definition } : {}),
                        ...(overlay !== undefined ? { overlay } : {}),
                        ...(overlayHash !== undefined ? { overlayHash } : {}),
                    },
                    scopes,
                    onLine,
                );
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
            // this router (see connection.ts): a device answers to a list of sandboxes now, each with its own
            // grant, and a writer that could not name the link would have to guess which one to overwrite.
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure. Its payload is MCP, understood by handleMcpMessage and by the tool it names,
        // not by this contract, and deliberately not by the daemon (see the contract for why).
        mcp: os.mcp.handler(async ({ input }) => await handleMcpMessage(input, runtime.scopes())),
        // The scopes are read HERE, per call, exactly as the MCP handler reads them, a stream opened before the
        // owner flipped a switch must not outlive the decision.
        runSandboxFlow: os.runSandboxFlow.handler(({ input }) => streamFlow(flowFor(input, runtime.scopes()))),
        /* The agent's own update and restart, through the same adapter — and the one stream whose ENDING is not
         * its answer: both ops stop the process serving this socket, so it dies mid-narration by design. The
         * work is detached before that happens (tools/agent.ts), and the reader confirms by the version. */
        runAgentFlow: os.runAgentFlow.handler(({ input }) => streamFlow((onLine) => runAgentOp(input.op, runtime.scopes(), onLine))),
    });
};
