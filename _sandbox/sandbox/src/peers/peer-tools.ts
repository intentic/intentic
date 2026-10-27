import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { MountSpec, TurnLease } from "../agent/tools/turn-mounts.js";
import { DEVICE_CLIENT_TIMEOUT_MS } from "./device-call-deadline.js";
import type { PeerKind } from "./peer.js";

// One server per granted connected machine (`device`), own browser (`webext`) or own phone (`phone`), named by its card id and mounted on
// the turn's lease: the turn's bearer reaches the peer's bridge at the daemon's one MCP door while the turn runs,
// and the door hands the bridge the conversation it came from. Never the peer's own enrollment token.
// A device's server carries how long the agent's MCP client waits on one call, longer than the bridge ever does: left
// to the client's default, Claude Code cut every device call at 60 s with "The operation timed out." (2026-10-27,
// peers/device-call-deadline.ts).
export const peerToolsOf = (kind: PeerKind, capabilities: readonly Capability[], lease: Pick<TurnLease, "open">): AgentTool[] =>
    capabilities.flatMap((capability) => {
        if (capability.kind !== kind) {
            return [];
        }
        const mount: MountSpec = { name: capability.id, target: { kind, id: capability.id } };
        return [lease.open(kind === "device" ? { ...mount, timeoutMs: DEVICE_CLIENT_TIMEOUT_MS } : mount)];
    });
