import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { DeviceAgentFlowSchema, DeviceFlowLineSchema, DeviceSandboxFlowSchema } from "../schemas/devices.js";
import { HostScopesSchema } from "../schemas/capabilities.js";
import { HostFactsSchema } from "../schemas/hosts.js";
import { OkSchema } from "../schemas/shared.js";

/* What a connected device can be ASKED, over the socket it opened to this sandbox.
 *
 * The direction is the unusual part: the machine is the oRPC SERVER and the daemon holds the client, even though
 * the machine is the side that dialled. A personal device sits behind NAT with a closing lid, so it can only
 * ever be the one that connects, but everything is asked OF it. oRPC's websocket adapter takes any socket-like
 * object on either side, so the roles are free to be the opposite of who placed the call.
 *
 * No `.route()` on these: HTTP method and path are for the daemon's own REST surface, and this contract never
 * touches HTTP. The procedure path IS the address.
 *
 * `mcp` IS THE DELIBERATE HOLE in the typing, and it is worth understanding before someone "fixes" it. The agent
 * talks to a machine in MCP, over the daemon's loopback bridge; if this contract described each tool, then the
 * daemon would have to know every tool's schema and translate, and a machine could no longer learn a tool
 * without a matching daemon release. Keeping one opaque procedure is what buys the machine an independent
 * release cycle. The payload is still validated where it is understood: on the machine, against the tool's own
 * schema, and by the agent's MCP client on the way back. */
export const hostContract = {
    // What this device is, pulled right after the socket authenticates, and again whenever the sandbox wants
    // it fresh. The card shows it, and the agent's skill pack is written against it.
    describe: oc.output(HostFactsSchema),
    // The grant, pushed down on every connect and again whenever the owner edits the card. The machine ENFORCES
    // it; nothing on the sandbox side checks a scope, so this call is the only thing that moves the boundary.
    setScopes: oc.input(HostScopesSchema).output(OkSchema),
    // Liveness, driven by the daemon: it doubles as the keepalive that stops an idle tunnel from reaping the
    // connection, and as the probe whose failure means the machine is gone rather than quiet.
    ping: oc.output(OkSchema),
    // One MCP JSON-RPC message in, its answer out, forwarded verbatim in both directions. See above.
    mcp: oc.input(z.unknown()).output(z.unknown()),
    /* One operation on one of this machine's sandboxes, narrated as it happens.
     *
     * TYPED, unlike `mcp`, and the difference is who is on the other end. `mcp`'s reader is a model, which has
     * nothing to do with a line as it arrives and everything to gain from the machine learning tools without a
     * daemon release. This reader is a PERSON watching a progress log: an update pulls an image and recreates a
     * container, which is minutes of silence unless the lines travel while they are produced. A stream is what
     * the browser needs, and a stream is the one thing an MCP tool result cannot be.
     *
     * The scope is still checked here, on the machine, by the same functions the MCP tools call, this adds a
     * way of WATCHING an operation, never a way of skipping the switch that permits it. */
    runSandboxFlow: oc.input(DeviceSandboxFlowSchema).output(eventIterator(DeviceFlowLineSchema)),
    /* Update or restart the agent on this device, narrated the same way — and the one call that expects to be
     * cut off, because the work it starts stops the process serving it (see DeviceAgentFlowSchema).
     *
     * A TYPED PROCEDURE rather than another `run_command` line, and the reason is the failure mode rather than
     * the typing: run through `run_command` this is a child of a process about to be SIGTERMed, and a swap
     * interrupted between its two renames leaves the device with no agent binary at all. Here the agent spawns
     * the work detached from the socket first, so nothing the daemon does to this stream can brick it.
     *
     * It takes "Run commands" — the same grant `run_command` takes, since this is literally a command its owner
     * could type — rather than the sandbox switches, which are about containers. An agent too old to serve this
     * procedure is a real answer too: the view falls back to naming the command, as it did before. */
    runAgentFlow: oc.input(DeviceAgentFlowSchema).output(eventIterator(DeviceFlowLineSchema)),
};
