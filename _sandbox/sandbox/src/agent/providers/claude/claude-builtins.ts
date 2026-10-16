import type { Options } from "@anthropic-ai/claude-agent-sdk";

type FlagSettings = Exclude<NonNullable<Options["settings"]>, string>;

// Claude Code 2.1.287 ships some of its own features as built-in mods: in-process hooks that load whatever
// `settingSources` says and that `disableAllHooks` does not switch off. `agents-md` is one: by default it hands the
// engine every AGENTS.md from the filesystem root down to the cwd as project instructions, and attaches a subfolder's
// on a Read under it. The daemon already composes AGENTS.md for every runtime (agent/prompt/workspace-memory.ts), so a
// Claude turn would read the owner's rules twice and pick up nested files no other runtime sees. `claude-md` leaves the
// engine's own CLAUDE.md walk standing, so a repository's CLAUDE.md still loads. The CLI reads this option from user,
// `--settings` (the SDK's `settings`) or managed settings, never from a project's, so a repository cannot turn it back.
export const CLAUDE_INSTRUCTION_FILES: FlagSettings = {
    pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md" } } },
};
