import type { Capability } from "@intentic/sandbox-contract";
import type { AgentTool } from "../agent/tools/agent-tools.js";
import type { TurnLease } from "../agent/tools/turn-mounts.js";

// One server per granted connected machine (`device`) or own browser (`webext`), named by its card id and mounted on
// the turn's lease: the turn's bearer reaches the peer's bridge at the daemon's one MCP door while the turn runs,
// and the door hands the bridge the conversation it came from. Never the peer's own enrollment token.
export const peerToolsOf = (kind: "device" | "webext", capabilities: readonly Capability[], lease: Pick<TurnLease, "open">): AgentTool[] =>
    capabilities.flatMap((capability) => (capability.kind === kind ? [lease.open({ name: capability.id, target: { kind, id: capability.id } })] : []));
