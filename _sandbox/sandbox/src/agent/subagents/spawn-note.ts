// The `agents` CLI teaching for runtimes with a shell but no seam to mount the spawn tool (Codex, OpenCode, Kimi, Pi,
// ACP agents); Claude Code and Cursor get MCP/custom tools instead, so this would repeat them. Sent once, on the
// opening turn, only where children.ts armSpawn actually allowed it.

export const SPAWN_NOTE_HEADER = "## Spawning child agents";
// Chat-row title; kept in sync with SPAWN_NOTE_HEADER.
export const SPAWN_NOTE_TITLE = "Spawning child agents";

// Models are not named here: the note is composed once on the opening turn and carried for every turn after, so a
// listing would go stale; `agents providers` answers that when actually asked.
export const spawnNote = (): string =>
    `${SPAWN_NOTE_HEADER}\n\n` +
    "This sandbox can start full agents on any connected provider from your shell:\n" +
    '  `agents spawn --provider <id> --model <id> [--effort <tier>] [--description "one line"] \'<task>\'`\n' +
    "prints the child's id and returns immediately. Both `--provider` and `--model` are required: a child spends " +
    "a real allowance and nothing is chosen for you. Run `agents providers` first for what is connected, which " +
    "models it serves and how much allowance each has left — it leaves out the models whose every account is at " +
    "its cap, so what it lists is what can actually run. The child runs as its own conversation in an isolated " +
    "copy of the repos, on the named provider's account (claude, codex, grok, kimi, gemini, cursor — e.g. " +
    "`--provider cursor --model composer-2.5`), and its finished work lands the workspace's ordinary way. " +
    "It sees nothing of this conversation: give it a self-contained task with every path, requirement and " +
    "constraint. Supervise it with `agents wait <id>` (blocks until it needs input or finishes; a blocked " +
    "child's question is printed whole), `agents answer <id> '<text>'` (settle its question — its permission " +
    "and plan cards are the owner's, not yours), `agents send <id> '<message>'` (steer it mid-turn, or run a " +
    "follow-up turn on a finished one, continuing its session), and `agents list`. A provider nobody has " +
    "connected fails with the words to say so.";
