import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// "This checkout is ALSO a Claude Code plugin": the daemon hands the directory to the Agent SDK's plugin
// loader, which reads skills/agents/hooks/commands/.mcp.json each turn, the daemon never parses plugin
// internals. Only Claude Code turns read it, so tools belong in `contributes.tools` and a skill every runtime should
// read in a capability card's `skill`; a `.mcp.json` here is deprecated and warned about at load.
export const AgentContributionSchema = z.object({
    path: z.string().optional().describe("Relative to the extension checkout. Absent ⇒ the checkout root."),
})
    .meta({ power: { key: "agent", sentence: "contributes skills, agents and hooks to the agent's turns" } });
export type AgentContribution = z.infer<typeof AgentContributionSchema>;

export const agentPoint = {
    name: "agent",
    description:
        "Declare that this checkout is also a Claude Code plugin, so Claude Code turns pick up its skills, agents, hooks and commands. Only Claude Code reads it: give the agent tools with `contributes.tools`, which every runtime gets, and put a skill every runtime should read in a capability card's `skill`. MCP servers in the plugin's `.mcp.json` are deprecated, reach Claude Code alone, and are warned about at load.",
    schema: AgentContributionSchema,
} as const satisfies ContributionPoint;
