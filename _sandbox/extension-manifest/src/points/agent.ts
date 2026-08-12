import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// "This checkout is ALSO a Claude Code plugin": the daemon hands the directory to the Agent SDK's plugin
// loader, which reads skills/agents/hooks/commands/.mcp.json each turn — the daemon never parses plugin
// internals.
export const AgentContributionSchema = z.object({
    path: z.string().optional().describe("Relative to the extension checkout. Absent ⇒ the checkout root."),
});
export type AgentContribution = z.infer<typeof AgentContributionSchema>;

export const agentPoint = {
    name: "agent",
    description:
        "Declare that this checkout is also a Claude Code plugin, so the agent picks up its skills, agents, hooks, commands and MCP servers each turn. The daemon hands the directory to the plugin loader and never parses what is in it.",
    schema: AgentContributionSchema,
} as const satisfies ContributionPoint;
