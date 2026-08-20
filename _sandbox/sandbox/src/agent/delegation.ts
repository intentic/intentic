import { DELEGATION_SESSION_TITLE } from "../grok/opencode.js";

/* Cross-provider delegation via the shell: the Claude primary agent drives the user's connected Codex/Grok
 * accounts through their CLIs (`codex exec`, `opencode run`) from its ordinary Bash tool. The note below is
 * appended to the system prompt only for providers with a usable credential this turn, so a disconnected
 * provider is never offered. Shell-based on purpose: children run inside the agent's tmux session (watchable
 * live in the terminal panel) and compose with everything Bash can do, the container is the isolation
 * boundary, same as every other agent command.
 *
 * The command templates carry the flags that make a delegation OBSERVABLE, and the note says why in one clause
 * each, because a flag the model doesn't understand is a flag it drops when it rewrites the command:
 *   - codex: `--dangerously-bypass-hook-trust` runs the daemon-authored status hooks (codex/codex-config.ts)
 *     that report the run's session id, blocked-on-permission state, and final message into the roster.
 *   - opencode: `--attach` runs the session on the daemon's warm server, whose event stream the roster reads
 *     (grok/opencode.ts), and `--title` is how a delegated session is told apart from a Grok chat turn there.
 * Both feed the `wait` tool (subagent-wait.ts), which is what replaces "tail the log and check back later". */

export interface DelegationTargets {
    // The sandbox-wide CODEX_HOME, streamAgent also injects it (with the translator bearer) into the shell env,
    // so the codex CLI is pre-authenticated on the ChatGPT subscription without the note naming any path.
    readonly codexHome?: string;
    // The warm OpenCode server's URL when xAI/Grok is connected, the `--attach` target. Credentials live on
    // the server, so the command needs no XDG_DATA_HOME prefix (what this note used to inline per command).
    readonly openCodeUrl?: string;
    // The bare xAI model id the note names (`--model xai/<grokModel>`), resolved live from OpenCode's catalog
    // so it tracks xAI's renames. Absent ⇒ point the agent at `opencode models` to pick a current one.
    readonly grokModel?: string;
}

// The note's fixed opening, what stripTurnPreamble anchors on to recognize an injected note in a stored
// user message (turn-preamble.ts).
export const DELEGATION_NOTE_HEADER = "## Delegating to other coding agents";

export const delegationNote = (targets: DelegationTargets): string | undefined => {
    if (targets.codexHome === undefined && targets.openCodeUrl === undefined) {
        return undefined;
    }
    const codex =
        targets.codexHome !== undefined
            ? "\n- Codex (OpenAI) — pre-authenticated via CODEX_HOME in your env:\n" +
              "  `codex exec --sandbox danger-full-access --dangerously-bypass-hook-trust --skip-git-repo-check --cd <dir> '<task>'`\n" +
              "  Keep the hook-trust flag: it enables this sandbox's own status hooks, which is what makes the wait tool see the run. " +
              "It prints its thread id; continue that thread with " +
              "`codex exec --sandbox danger-full-access --dangerously-bypass-hook-trust resume <threadId> '<follow-up>'`."
            : "";
    const grokModelFlag = targets.grokModel !== undefined ? `--model xai/${targets.grokModel} ` : "";
    const grokModelHint =
        targets.grokModel !== undefined ? "" : ` List xAI's current models with \`opencode models\` and pass one as \`--model xai/<id>\`.`;
    const grok =
        targets.openCodeUrl !== undefined
            ? `\n- Grok (xAI) via OpenCode:\n` +
              `  \`opencode run --attach ${targets.openCodeUrl} --title ${DELEGATION_SESSION_TITLE} ${grokModelFlag}'<task>'\`\n` +
              `  Keep the attach and title flags: they run the session where this sandbox can report its status. ` +
              `Continue a session by adding \`--session <id>\`.${grokModelHint}`
            : "";
    return (
        `${DELEGATION_NOTE_HEADER}\n\n` +
        "The user's connected agent accounts are runnable from your shell. Delegates see none of this " +
        "conversation — give them a self-contained prompt with every path, requirement, and constraint. " +
        "Run one with `run_in_background: true` (or let a long run detach into your tmux session), then call the " +
        "`wait` tool with the Bash call's id — it returns when the delegate needs input or finishes, with its " +
        "report; don't sleep or re-read its terminal in a loop." +
        codex +
        grok
    );
};
