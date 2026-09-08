import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { DeviceAgentFlowSchema, DeviceFlowLineSchema, DeviceSandboxFlowSchema } from "../schemas/devices.js";
import { HostScopesSchema } from "../schemas/capabilities.js";
import { HostFactsSchema } from "../schemas/hosts.js";
import { OkSchema } from "../schemas/shared.js";

// What a connected device can be asked, over the socket it opened; the machine is the oRPC server, the daemon the
// client. No `.route()`: the procedure path is the address, not HTTP. `mcp` stays opaque (`z.unknown()`) so a machine
// can add tools without a daemon release; validated on the machine and by the agent's MCP client.
export const hostContract = {
    // Device facts, refreshed on connect and on demand; the agent's skill pack is written against this shape.
    describe: oc.output(HostFactsSchema),
    // Pushed on connect and on edit; the machine enforces the grant, nothing on the sandbox side checks a scope.
    setScopes: oc.input(HostScopesSchema).output(OkSchema),
    // Daemon-driven liveness; doubles as keepalive against an idle tunnel and the gone-vs-quiet probe.
    ping: oc.output(OkSchema),
    // One MCP JSON-RPC message forwarded verbatim in both directions, unmodified.
    mcp: oc.input(z.unknown()).output(z.unknown()),
    // Streamed for a person watching progress; the scope is checked on the machine, this only adds visibility.
    runSandboxFlow: oc.input(DeviceSandboxFlowSchema).output(eventIterator(DeviceFlowLineSchema)),
    // Spawns the work detached from the socket, so restarting the agent process cannot brick a swap in progress.
    runAgentFlow: oc.input(DeviceAgentFlowSchema).output(eventIterator(DeviceFlowLineSchema)),
};
