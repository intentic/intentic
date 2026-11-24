import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { AgentsRegistry } from "./agents-registry.js";

// The card `list()` holds for `id`, built alone: the conversation while it is still on the board, else undefined.
// `list().find(...)` built every live card's summary to keep one, inside per-item loops (each storage item, each held
// checkout of a sweep), which made those passes quadratic in the board (2026-11-24).
export const boardCard = (agents: Pick<AgentsRegistry, "entry" | "get">, id: string): AgentSummary | undefined =>
    agents.entry(id)?.archivedAt === undefined ? agents.get(id) : undefined;
