import { narrate } from "@intentic/base/async";
import { type HostScopes, type DeviceFlowLine, type DeviceSandboxFlow, type DeviceSandboxOp, hostContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";
import { runAgentOp } from "./tools/agent.js";
import {
    manageSandbox,
    reconnectSandbox,
    removeSandbox,
    reshapeSandbox,
    runnerFlow,
    type SandboxSwap,
    swapSandbox,
    tailSandboxLogs,
} from "./tools/sandboxes.js";

// What this device answers, as the oRPC server on the socket it dialled out; the peer that dials and the peer
// that serves are independent, oRPC's websocket adapter attaches to any socket-like object. `scopes` is a live
// reference: `setScopes` takes effect on the very next tool call, not at the next reconnect.
export interface HostRuntime {
    readonly scopes: () => HostScopes;
    readonly setScopes: (scopes: HostScopes) => void;
    readonly log: (message: string) => void;
}

// A flow's callback-reported lines as the stream the browser reads (@intentic/base's `narrate`); this is only
// this wire's terminal frame.
const streamFlow = (run: (onLine: (line: string) => void) => Promise<string>): AsyncGenerator<DeviceFlowLine> =>
    narrate(run, (outcome): DeviceFlowLine => (outcome.ok ? { kind: "result", message: outcome.value } : { kind: "error", message: outcome.error }));

type Flow = (onLine: (line: string) => void) => Promise<string>;
type FlowFor = (flow: DeviceSandboxFlow, scopes: HostScopes) => Flow;

// A container that belongs to the asking sandbox rather than to a person; `slug` is the runner's name. The parent's
// shape rides to `ic` as files, so the runner starts as its twin instead of a bare base image.
const runnerFlowFor: FlowFor =
    ({ op, slug, parentUrl, pair, definition, overlay, overlayHash }, scopes) =>
    (onLine) =>
        runnerFlow(
            op === "runner-remove" ? op : "runner-up",
            slug,
            parentUrl,
            pair,
            {
                ...(definition === undefined ? {} : { definition }),
                ...(overlay === undefined ? {} : { overlay }),
                ...(overlayHash === undefined ? {} : { overlayHash }),
            },
            scopes,
            onLine,
        );

// The four that move a sandbox between images that already exist, all one `ic` flow; `hash` pins which overlay.
const swapFlowFor =
    (swap: SandboxSwap): FlowFor =>
    ({ slug, hash }, scopes) =>
    (onLine) =>
        swapSandbox(swap, slug, hash, scopes, onLine);

// Which function each op is, total over the op enum so a new op cannot be added without one: start/stop/restart are a
// docker call, `logs` is a read, and the rest run `ic` and narrate themselves for minutes.
const FLOWS: Record<DeviceSandboxOp, FlowFor> = {
    start:
        ({ slug }, scopes) =>
        async () =>
            await manageSandbox("start", slug, scopes),
    stop:
        ({ slug }, scopes) =>
        async () =>
            await manageSandbox("stop", slug, scopes),
    restart:
        ({ slug }, scopes) =>
        async () =>
            await manageSandbox("restart", slug, scopes),
    prepare: swapFlowFor("prepare"),
    update: swapFlowFor("update"),
    rebuild: swapFlowFor("rebuild"),
    rollback: swapFlowFor("rollback"),
    // The same image with a different share of this machine: the one op with a payload of its own.
    reshape:
        ({ slug, resources }, scopes) =>
        (onLine) =>
            reshapeSandbox(slug, resources, scopes, onLine),
    remove:
        ({ slug }, scopes) =>
        (onLine) =>
            removeSandbox(slug, scopes, onLine),
    logs:
        ({ slug }, scopes) =>
        (onLine) =>
            tailSandboxLogs(slug, scopes, onLine),
    // setupCode carries the values a drifted sandbox is missing; nothing on this machine can supply them.
    reconnect:
        ({ slug, setupCode }, scopes) =>
        (onLine) =>
            reconnectSandbox(slug, setupCode, scopes, onLine),
    "runner-up": runnerFlowFor,
    "runner-remove": runnerFlowFor,
};

export const createHostRouter = (runtime: HostRuntime) => {
    const os = implement(hostContract);
    return os.router({
        describe: os.describe.handler(async () => await hostFacts(runtime.scopes())),
        setScopes: os.setScopes.handler(({ input }) => {
            runtime.setScopes(input);
            runtime.log(`permissions updated: commands ${input.shell}, writes ${input.write}, screen ${input.screen}`);
            // Caching it on disk belongs to the connection (see connection.ts), not this router: a device answers to a
            // list of sandboxes now, and the router can't name which one pushed.
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure. Its payload is MCP, understood by handleMcpMessage and the tool it names, not by
        // this contract or the daemon.
        mcp: os.mcp.handler(async ({ input }) => await handleMcpMessage(input, runtime.scopes())),
        // Read here, per call, exactly as the MCP handler reads them: a stream opened before the owner flipped a
        // switch must not outlive the decision.
        runSandboxFlow: os.runSandboxFlow.handler(({ input }) => streamFlow(FLOWS[input.op](input, runtime.scopes()))),
        // The agent's own update/restart, through the same adapter, and the one stream whose ending is not its answer:
        // both ops kill the process serving this socket. The work is detached first (tools/agent.ts); the reader
        // confirms by the version.
        runAgentFlow: os.runAgentFlow.handler(({ input }) => streamFlow((onLine) => runAgentOp(input.op, runtime.scopes(), onLine))),
    });
};
