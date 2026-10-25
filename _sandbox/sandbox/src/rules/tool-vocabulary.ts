/* THE ONE TOOL VOCABULARY EVERY RUNTIME IS TRANSLATED INTO.

   Every loop names its tools its own way: Codex's `exec_command` and `apply_patch`, Cursor's `Shell`, Pi's `bash`,
   OpenCode's `shell` and `<prefix><server>_<tool>`, an ACP agent's free-form titles. The daemon's rules are written once,
   in Claude Code's names (a tool list's `Bash(git log:*)`, a persona's withheld `Edit`, a fence on `Read`), and each
   runtime's translator maps its own names onto these before a rule reads them: codex-hooks.ts `codexListName`,
   pi-hooks.ts `piToolName`, cursor-tool-list.ts, opencode-allowlist.ts. A card's category is read off the same names
   (runtimes/decorators/vendor-events.ts toolCard, through agent-context's toolCategoryOf), and an MCP tool is spelled
   `mcp__<server>__<tool>` throughout. This module names the groups a persona's powers withhold, so each translator and
   every rule share one list. 2026-10-25: four translators each kept their own idea of it, so a persona's limits bound
   only Claude Code. */

// The canonical names of each power a persona can withhold (personas/personas.ts reads these).
export const READ_TOOL_NAMES = ["Read", "Glob", "Grep", "NotebookRead"] as const;
export const WRITE_TOOL_NAMES = ["Edit", "Write", "NotebookEdit"] as const;
export const SHELL_TOOL_NAMES = ["Bash", "BashOutput", "KillShell"] as const;
export const WEB_TOOL_NAMES = ["WebFetch", "WebSearch"] as const;
export const DELEGATE_TOOL_NAMES = ["Agent", "Task", "Workflow"] as const;
