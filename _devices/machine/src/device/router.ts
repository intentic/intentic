import { narrate } from "@intentic/base/async";
import { type DeviceScopes, type DeviceFlowLine, type DeviceSandboxFlow, type DeviceSandboxOp, deviceContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { calling } from "./indicator.js";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";
import { machineReport } from "../sync/report.js";
import { runAgentOp } from "./tools/agent.js";
import {
    createSandbox,
    forgetShape,
    manageSandbox,
    reconnectSandbox,
    removeSandbox,
    reshapeSandbox,
    runnerFlow,
    type SandboxSwap,
    shapeSandbox,
    swapSandbox,
    tailSandboxLogs,
} from "./tools/sandboxes.js";

// What this device answers, as the oRPC server on the socket it dialled out; the peer that dials and the peer
// that serves are independent, oRPC's websocket adapter attaches to any socket-like object. `scopes` is a live
// reference: `setScopes` takes effect on the very next tool call, not at the next reconnect.
export interface HostRuntime {
    // The sandbox this socket answers, which names it on this machine's screen while it drives the desktop.
    readonly sandboxUrl: string;
    readonly scopes: () => DeviceScopes;
    readonly setScopes: (scopes: DeviceScopes) => void;
    readonly log: (message: string) => void;
}

// A flow's callback-reported lines as the stream the browser reads (@intentic/base's `narrate`); this is only
// this wire's terminal frame.
const streamFlow = (run: (onLine: (line: string) => void) => Promise<string>): AsyncGenerator<DeviceFlowLine> =>
    narrate(run, (outcome): DeviceFlowLine => (outcome.ok ? { kind: "result", message: outcome.value } : { kind: "error", message: outcome.error }));

type Flow = (onLine: (line: string) => void) => Promise<string>;
type FlowFor = (flow: DeviceSandboxFlow, scopes: DeviceScopes) => Flow;

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

// Which function each op is, total over the op enum so a new op cannot be added without one: `logs` is a read, and every
// other op runs `ic` and narrates itself (start and restart for minutes, when a shape is saved for the next restart).
const FLOWS: Record<DeviceSandboxOp, FlowFor> = {
    start:
        ({ slug }, scopes) =>
        async (onLine) =>
            await manageSandbox("start", slug, scopes, onLine),
    stop:
        ({ slug }, scopes) =>
        async () =>
            await manageSandbox("stop", slug, scopes),
    restart:
        ({ slug }, scopes) =>
        async (onLine) =>
            await manageSandbox("restart", slug, scopes, onLine),
    prepare: swapFlowFor("prepare"),
    update: swapFlowFor("update"),
    rebuild: swapFlowFor("rebuild"),
    rollback: swapFlowFor("rollback"),
    // The same image with a different shape: whole, and when it takes effect. Refused without either, before ic runs.
    "set-shape":
        ({ slug, shape, when }, scopes) =>
        (onLine) => {
            if (shape === undefined || when === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "A shape is set whole, with when it takes effect: `shape` and `when` are both required." });
            }
            return shapeSandbox(slug, shape, when, scopes, onLine);
        },
    "forget-shape":
        ({ slug }, scopes) =>
        (onLine) =>
            forgetShape(slug, scopes, onLine),
    // The old spelling of `set-shape`, for one release: a delta, with `later` for the next restart.
    reshape:
        ({ slug, resources, later }, scopes) =>
        (onLine) =>
            reshapeSandbox(slug, resources, scopes, onLine, { later }),
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
        ({ slug, setupCode, platformUrl }, scopes) =>
        (onLine) =>
            reconnectSandbox(slug, setupCode, platformUrl, scopes, onLine),
    // The same claim, for a row that has never run anywhere: `slug` is what the claim will produce, not what is here.
    create:
        ({ slug, setupCode, platformUrl }, scopes) =>
        (onLine) =>
            createSandbox(slug, setupCode, platformUrl, scopes, onLine),
    "runner-up": runnerFlowFor,
    "runner-remove": runnerFlowFor,
};

export const createHostRouter = (runtime: HostRuntime) => {
    const os = implement(deviceContract);
    return os.router({
        describe: os.describe.handler(async () => await hostFacts(runtime.scopes())),
        // Behind "Run commands" like `status`; FORBIDDEN is the one refusal the sandbox reads as that switch.
        report: os.report.handler(async () => {
            if (runtime.scopes().shell !== "on") {
                throw new ORPCError("FORBIDDEN", { message: `"Run commands" is switched off for this device, so it does not describe its folders and ports.` });
            }
            return await machineReport();
        }),
        setScopes: os.setScopes.handler(({ input }) => {
            runtime.setScopes(input);
            runtime.log(`permissions updated: commands ${input.shell}, writes ${input.write}, screen ${input.screen}`);
            // Caching it on disk belongs to the connection (see connection.ts), not this router: a device answers to a
            // list of sandboxes now, and the connection owns this one's entry in it.
            return { ok: true };
        }),
        ping: os.ping.handler(() => ({ ok: true })),
        // The one opaque procedure. Its payload is MCP, understood by handleMcpMessage and the tool it names, not by
        // this contract or the daemon. Run as this link's call, so what it does to the desktop is shown under its name.
        mcp: os.mcp.handler(async ({ input }) => await calling.run(runtime, async () => await handleMcpMessage(input, runtime.scopes()))),
        // Read here, per call, exactly as the MCP handler reads them: a stream opened before the owner flipped a
        // switch must not outlive the decision.
        runSandboxFlow: os.runSandboxFlow.handler(({ input }) => streamFlow(FLOWS[input.op](input, runtime.scopes()))),
        // The agent's own update/restart, through the same adapter, and the one stream whose ending is not its answer:
        // both ops kill the process serving this socket. The work is detached first (tools/agent.ts); the reader
        // confirms by the version.
        runAgentFlow: os.runAgentFlow.handler(({ input }) => streamFlow((onLine) => runAgentOp(input.op, runtime.scopes(), onLine))),
    });
};
