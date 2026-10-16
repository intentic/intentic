import { SPAWN_NOTE_HEADER } from "../../sessions/vocabulary/prompt-envelope.js";

// The `agents` CLI teaching for runtimes with a shell but no seam to mount the spawn tool (Codex, OpenCode, Pi, ACP
// agents); Claude Code and Cursor get MCP/custom tools instead, so this would repeat them. Sent once, on the opening
// turn, only where children.ts armSupervisor actually allowed it.

// Models are not named here: the note is composed once on the opening turn and carried for every turn after, so a
// listing would go stale; `agents providers` answers that when actually asked.
export const spawnNote = (): string =>
    `${SPAWN_NOTE_HEADER}\n\n` +
    "This sandbox can start subagents, full agents on any connected provider, from your shell:\n" +
    '  `agents spawn --provider <id> --model <id> [--effort <tier>] [--description "one line"] \'<task>\'`\n' +
    "prints the subagent's id and returns immediately. Both `--provider` and `--model` are required: a subagent spends " +
    "a real allowance and nothing is chosen for you. Run `agents providers` first for what is connected, which " +
    "models it serves and how much allowance each has left — it leaves out every model the records call spent, and a " +
    "spawn naming one is refused before it takes a seat. What it lists is what is not known to be spent, which is not " +
    "the same as a promise: a provider that publishes no allowance is listed as `not metered`, and the only thing that " +
    "ever measures one of those is a turn it has already refused. Each figure is one account's, and subagents started " +
    "together draw on it together: N of them spend it about N times as fast as one. The listing says which pool each " +
    "figure is (a five-hour window, a weekly one), how many agents already run on each provider, and when each last ran " +
    "out, how far into its window and under how many agents: read that before starting several on one provider. " +
    "The subagent runs as its own conversation in an isolated " +
    "copy of the repos cut from your current work, on the named provider's account (claude, codex, grok, kimi, gemini, " +
    "cursor — e.g. `--provider cursor --model composer-2.5`). Its finished work comes back into your checkout, as an " +
    "in-process subagent's edits do; where it clashes with your edits it is held, and `agents merge <id>` brings it in. " +
    "It sees nothing of this conversation: give it a self-contained task with every path, requirement and " +
    "constraint. Supervise it with `agents wait <id>` (blocks until it needs input or finishes; a blocked " +
    "subagent's question is printed whole), `agents answer <id> '<text>'` (settle its question — its permission " +
    "and plan cards are the owner's, not yours), `agents send <id> '<message>'` (steer it mid-turn, or run a " +
    "follow-up turn on a finished one, continuing its session), and `agents list`. A provider nobody has " +
    "connected fails with the words to say so.";
