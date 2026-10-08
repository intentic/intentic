import { narrate } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { DeviceScopes, DeviceFlowLine, DeviceSandboxFlow, DeviceSandboxOp, ProjectDelivery, ProjectDeliveryResult } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { audit } from "./audit.js";
import { readGrant, tolerantDeviceContract } from "./grant.js";
import { calling } from "./indicator.js";
import { catchLoopback } from "./loopback-catch.js";
import { handleMcpMessage } from "./mcp.js";
import { hostFacts } from "./tools/describe.js";
import { DeliveryRefused, deliverProject } from "../sync/project/project-delivery.js";
import { machineReport } from "../sync/report.js";
import { runAgentOp } from "./tools/agent.js";
import {
    createSandbox,
    forgetShape,
    manageSandbox,
    prepareInBackground,
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

// The four that move a sandbox between images that already exist, all one `ic` flow; `hash` pins which overlay, and a
// rollback's `to` which of the versions kept on the machine it goes back to.
const swapFlowFor =
    (swap: SandboxSwap): FlowFor =>
    ({ slug, hash, to }, scopes) =>
    (onLine) =>
        swapSandbox(swap, slug, hash, scopes, onLine, to);

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
    // The same download under the background tick's rules, sent by the update card when it opens.
    "prepare-background":
        ({ slug }, scopes) =>
        (onLine) =>
            prepareInBackground(slug, scopes, onLine),
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

// The flow an order asks for. `to` belongs to a rollback alone: an order carrying it for anything else is refused rather
// than carried out without it, like every field this agent does not expect.
const flowFor: FlowFor = (input, scopes) =>
    input.to !== undefined && input.op !== "rollback"
        ? () => {
              throw new ORPCError("BAD_REQUEST", { message: `"to" names a version to go back to, which only a rollback takes, not ${input.op}.` });
          }
        : FLOWS[input.op](input, scopes);

// LANDED WORK INTO A FOLDER ATTACHED TO THIS COMPUTER'S SANDBOX (sync/project/project-delivery.ts). Behind no switch of the
// grant: the folder's own opt-in (`deliver: "auto"`, which `sync attach` records) is the permission, and only a folder of
// the sandbox on this link's other end is ever found. Not a tool either, so no agent can call it; the daemon does, after
// a land. Logged and audited like every call, and a refusal travels as its own sentence for the land's card.
const deliverOverLink = async (runtime: HostRuntime, delivery: ProjectDelivery): Promise<ProjectDeliveryResult> => {
    const asked = `${delivery.remoteDir} ← ${delivery.landing.agentId}${delivery.landing.title === undefined ? "" : ` (${delivery.landing.title})`}, ${delivery.files.length} file(s)`;
    try {
        const result = await deliverProject(delivery, runtime.sandboxUrl);
        const said = `${asked}: ${result.applied.length} applied, ${result.merged.length} merged, ${result.already.length} already there, ${result.conflicts.length} kept as the owner has them${result.point === undefined ? "" : `, restore point ${result.point}`}`;
        void audit({ tool: "deliverProject", ok: true, detail: `${result.folder}: ${said}` });
        runtime.log(`${runtime.sandboxUrl}: delivered ${said}`);
        return result;
    } catch (error) {
        void audit({ tool: "deliverProject", ok: false, detail: `${asked}: ${error instanceof DeliveryRefused ? "refused" : "failed"}: ${errorMessage(error)}` });
        runtime.log(`${runtime.sandboxUrl}: did not deliver ${asked}: ${errorMessage(error)}`);
        throw error instanceof DeliveryRefused
            ? new ORPCError(error.code, { message: error.message })
            : new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error) });
    }
};

export const createHostRouter = (runtime: HostRuntime) => {
    const os = implement(tolerantDeviceContract);
    // Switches a grant carried that this agent does not know, each said once per link rather than on every reconnect.
    const unknownSaid = new Set<string>();
    return os.router({
        describe: os.describe.handler(async () => await hostFacts(runtime.scopes())),
        // Behind "Run commands" like `status`; FORBIDDEN is the one refusal the sandbox reads as that switch.
        report: os.report.handler(async () => {
            if (runtime.scopes().shell !== "on") {
                throw new ORPCError("FORBIDDEN", { message: `"Run commands" is switched off for this device, so it does not describe its folders and ports.` });
            }
            return await machineReport();
        }),
        // Read tolerantly (grant.ts): a switch a newer sandbox added is left off rather than refused, since a refusal
        // here drops the link and the sandbox redials it forever.
        setScopes: os.setScopes.handler(({ input }) => {
            const { scopes, unknown } = readGrant(input);
            runtime.setScopes(scopes);
            runtime.log(`permissions updated: commands ${scopes.shell}, writes ${scopes.write}, screen ${scopes.screen}`);
            const news = unknown.filter((name) => !unknownSaid.has(name));
            if (news.length > 0) {
                for (const name of news) {
                    unknownSaid.add(name);
                }
                runtime.log(
                    `${runtime.sandboxUrl}: the permissions it pushed include ${news.join(", ")}, which this agent does not know; they stay off here until the agent is updated.`,
                );
            }
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
        runSandboxFlow: os.runSandboxFlow.handler(({ input }) => streamFlow(flowFor(input, runtime.scopes()))),
        // The agent's own update/restart, through the same adapter, and the one stream whose ending is not its answer:
        // both ops kill the process serving this socket. The work is detached first (tools/agent.ts); the reader
        // confirms by the version.
        runAgentFlow: os.runAgentFlow.handler(({ input }) => streamFlow((onLine) => runAgentOp(input.op, onLine))),
        // A sign-in's loopback redirect, caught here for the sandbox that started it (loopback-catch.ts). Behind no
        // switch: only the sandbox's own sign-in arms it, never a tool, it binds loopback alone, and what it catches is
        // worthless without the verifier the sandbox keeps.
        catchLoopback: os.catchLoopback.handler(({ input, signal }) =>
            catchLoopback(input, signal, (message) => runtime.log(`${runtime.sandboxUrl}: ${message}`)),
        ),
        deliverProject: os.deliverProject.handler(async ({ input }) => await deliverOverLink(runtime, input)),
    });
};
