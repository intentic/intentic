// The Claude Code built-ins withheld from every turn on that loop, ahead of what the turn's own policy withholds.

// CLI scheduling tools are dead here (the process dies at turn end); automations and the watch tools replace them.
const CLI_SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];

// Built-ins the sandbox already answers with its own tool, or that cannot work here. Each one's schema rides every
// request, tool search or not, since that defers MCP tools only: these six were ~26k characters (~9k tokens) of every
// prompt, and over 164 sessions in the 21 days to 2026-11-17 not one of them was called.
//   Monitor          run_in_background and mcp__subagents__wait in the turn, mcp__watch__start after it; dies with the CLI
//   Workflow         mcp__subagents__workflow takes the same script, on any provider, with its children on the board
//   ListAgents       the `agents` CLI; SendMessage stays, since resuming an in-process helper goes through it
//   EnterWorktree,   every conversation already works in a worktree of its own, and the sandbox refuses worktree moves
//   ExitWorktree
//   RemoteTrigger    claude.ai routines; automations are this sandbox's
const CLI_SHADOWED_TOOLS = ["Monitor", "Workflow", "ListAgents", "EnterWorktree", "ExitWorktree", "RemoteTrigger"];

// Plan and question tools stay, on an unattended turn too: their cards wait for the owner like every other.
export const withheldTools = (policyDisallowed: readonly string[] = []): string[] => [
    ...new Set([...CLI_SCHEDULER_TOOLS, ...CLI_SHADOWED_TOOLS, ...policyDisallowed]),
];
