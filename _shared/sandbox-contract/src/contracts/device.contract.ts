import { oc } from "@orpc/contract";
import { streamOf } from "../protocol/routes.js";
import { z } from "zod";
import { DeviceAgentFlowSchema, DeviceFlowLineSchema, DeviceReportSchema, DeviceSandboxFlowSchema } from "../schemas/devices.js";
import { DeviceScopesSchema } from "../schemas/capabilities.js";
import { DeviceFactsSchema } from "../schemas/hosts.js";
import { LoopbackCatchEventSchema, LoopbackCatchSchema } from "../schemas/loopback-catch.js";
import { OkSchema } from "../schemas/shared.js";
import { ProjectDeliveryResultSchema, ProjectDeliverySchema } from "../schemas/project-delivery.js";
import { StageArtifactResultSchema, StageArtifactSchema } from "../schemas/device-artifacts.js";

// What a connected device can be asked, over the socket it opened; the machine is the oRPC server, the daemon the
// client. No `.route()`: the procedure path is the address, not HTTP. Every input is strict (devices.ts says why). `mcp` stays opaque (`z.unknown()`) so a machine
// can add tools without a daemon release; validated on the machine and by the agent's MCP client.
export const deviceContract = {
    // Device facts, refreshed on connect and on demand; the agent's skill pack is written against this shape.
    describe: oc.output(DeviceFactsSchema),
    // The machine's folders, ports and agent health, answered by the agent itself; refused (FORBIDDEN) with "Run commands" off.
    report: oc.output(DeviceReportSchema),
    // Pushed on connect and on edit; the machine enforces the grant, nothing on the sandbox side checks a scope. Strict,
    // like every input here: a switch this agent does not know is refused rather than silently not enforced. The daemon
    // sends the card's whole config, so the card's `platform` is accepted and ignored.
    setScopes: oc.input(DeviceScopesSchema.extend({ platform: z.string().optional() }).strict()).output(OkSchema),
    // Daemon-driven liveness; doubles as keepalive against an idle tunnel and the gone-vs-quiet probe.
    ping: oc.output(OkSchema),
    // One MCP JSON-RPC message forwarded verbatim in both directions, unmodified.
    mcp: oc.input(z.unknown()).output(z.unknown()),
    // Streamed for a person watching progress; the scope is checked on the machine, this only adds visibility.
    runSandboxFlow: oc.input(DeviceSandboxFlowSchema).output(streamOf(DeviceFlowLineSchema)),
    // Spawns the work detached from the socket, so restarting the agent process cannot brick a swap in progress.
    runAgentFlow: oc.input(DeviceAgentFlowSchema).output(streamOf(DeviceFlowLineSchema)),
    // Watches one loopback address on this machine for a sign-in's redirect (schemas/loopback-catch.ts); only the
    // daemon arms it, never a tool, and aborting the stream is how it stops. Sent only to an agent advertising
    // `loopback-catch`.
    catchLoopback: oc.input(LoopbackCatchSchema).output(streamOf(LoopbackCatchEventSchema)),
    // Landed work written into the owner's folder that `/work/<name>` copies (schemas/project-delivery.ts). Only the
    // daemon calls it, after a land, and only on an agent advertising `project-delivery`; the machine refuses a folder
    // that did not opt into delivery, takes a restore point first, and never writes over an edit of the owner's own.
    deliverProject: oc.input(ProjectDeliverySchema).output(ProjectDeliveryResultSchema),
    // A program this sandbox built, carried in chunks into the machine's own runs folder (schemas/device-artifacts.ts).
    // Only the daemon calls it, for the agent's `devices push`, and only on an agent advertising `programs`; the machine
    // refuses every op unless "Run programs this sandbox sends" is on.
    stageArtifact: oc.input(StageArtifactSchema).output(StageArtifactResultSchema),
};
