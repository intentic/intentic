/* THE CROSS-RUNTIME SPAWN TEACHING, one short note naming the `agents` CLI (bin/agents), for the runtimes that
 * have a shell but no seam the spawn TOOL can mount through.
 *
 * Who hears what, and why, is the whole design:
 *   · the Claude Code loop gets the `spawn`/`wait` MCP tools (agent/subagent-wait.ts), always in the prompt,
 *     so a note would say the same thing twice;
 *   · Cursor gets the same pair as custom tools (cursor/cursor-tools.ts), self-describing for the same reason;
 *   · everything else with a shell — Codex, OpenCode, Kimi, Pi, ACP agents — hears THIS, once, on the
 *     conversation's opening turn (the iq teaching's rule: the provider session carries it thereafter).
 *
 * Offered only where planTurn actually armed the conversation (children/children.ts armSpawn), the delegation
 * note's own law: an agent told it may spawn on a sandbox whose persona withheld it is worse than one never
 * told. */

export const SPAWN_NOTE_HEADER = "## Spawning helper agents";

export const spawnNote = (): string =>
    `${SPAWN_NOTE_HEADER}\n\n` +
    "This sandbox can start full agents on any connected provider from your shell:\n" +
    '  `agents spawn [--provider <id>] [--model <id>] [--effort <tier>] [--description "one line"] \'<task>\'`\n' +
    "prints the child's id and returns immediately. The child runs as its own conversation in an isolated copy " +
    "of the repos, on the named provider's account (claude, codex, grok, kimi, gemini, cursor — e.g. " +
    "`--provider cursor --model composer-2.5`), and its finished work lands the workspace's ordinary way. " +
    "It sees nothing of this conversation: give it a self-contained task with every path, requirement and " +
    "constraint. Follow it with `agents wait <id>` (blocks until it needs input or finishes, then prints its " +
    "status and report) or `agents list` (all of this conversation's children). A provider nobody has " +
    "connected fails with the words to say so.";
