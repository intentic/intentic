import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { MountSpec, TurnLease } from "../agent/tools/turn-mounts.js";
import { WEBEXT_CLIENT_TIMEOUT_MS } from "./webext-call-deadline.js";
import { DEVICE_CLIENT_TIMEOUT_MS } from "./device-call-deadline.js";
import type { PeerKind } from "./peer.js";

/** The server every granted machine is mounted under: `mcp__devices__run_command` (hosts/devices/devices-server.ts). */
export const DEVICES_SERVER = "devices";

// How long the agent's MCP client waits on one call, for a kind of peer whose calls run past a client's default.
const clientTimeoutOf = (kind: PeerKind): number | undefined =>
    kind === "device" ? DEVICE_CLIENT_TIMEOUT_MS : kind === "webext" ? WEBEXT_CLIENT_TIMEOUT_MS : undefined;

// One server per granted connected machine (`device`), own browser (`webext`) or own phone (`phone`), named by its card id and mounted on
// the turn's lease: the turn's bearer reaches the peer's bridge at the daemon's one MCP door while the turn runs,
// and the door hands the bridge the conversation it came from. Never the peer's own enrollment token.
// A device's and a browser's server carry how long the agent's MCP client waits on one call, longer than the bridge ever
// does: left to the client's default, Claude Code cut every device call at 60 s with "The operation timed out."
// (2026-10-27, peers/device-call-deadline.ts), and every browser call too, a nine-minute wait_for included
// (peers/webext-call-deadline.ts).
// Devices are the exception: every granted machine rides ONE server, `devices`, whose tools take `device`
// (hosts/devices/devices-server.ts), so N machines cost one copy of the tool schemas rather than N.
export const peerToolsOf = (kind: PeerKind, capabilities: readonly Capability[], lease: Pick<TurnLease, "open">): AgentTool[] => {
    if (kind === "device") {
        const ids = capabilities.filter((capability) => capability.kind === "device").map((capability) => capability.id);
        return ids.length === 0 ? [] : [lease.open({ name: DEVICES_SERVER, target: { kind: "devices", ids }, timeoutMs: DEVICE_CLIENT_TIMEOUT_MS })];
    }
    return capabilities.flatMap((capability) => {
        if (capability.kind !== kind) {
            return [];
        }
        const mount: MountSpec = { name: capability.id, target: { kind, id: capability.id } };
        const timeoutMs = clientTimeoutOf(kind);
        return [lease.open(timeoutMs === undefined ? mount : { ...mount, timeoutMs })];
    });
};
