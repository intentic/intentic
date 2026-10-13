import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { TurnPlacement } from "../../../conversations/worktrees/isolation.js";
import { envKeyFlags, NO_PROMPTS, paneHop, PIPESTATUS_TRAP, POLITE_PREFIX, runRootFor, tmuxRunEnabled } from "../../../agent/tools/agent-terminals.js";
import { writeRunFile } from "../../../agent/tools/jobs/run-files.js";
import { AGENT_SESSION_ENV } from "../../../system/boot/container-owner.js";
import { WORKLOAD_ENV } from "../../../seams/workload-stamp.js";
import { TMUX_RUN_BIN } from "../../../terminal/terminal-run.js";

// A Cursor turn's shell in the terminal panel: every command the model runs goes through bin/tmux-run into the
// `agent-<session>` tmux session the panel attaches to, as the Claude Code loop's Bash does (agent-terminals.ts). The
// hook script runs it (cursor-hook-script.ts): Cursor's own shell starts the script, the script fetches the command from
// the daemon by an opaque id, and what the daemon hands it is this tmux-run line, so the command still sits in no argv
// Cursor records or `pkill -f` matches: it travels by file, as the Claude loop's does.

export interface CursorTerminal {
    // The tmux session the panel attaches to, named from Cursor's agent id as every runtime names it from its session.
    readonly session: string;
    readonly sessionId: string;
    // The turn's shell environment by name: tmux-run forwards each from its own environment onto the pane, since the
    // pane otherwise inherits the tmux server's stale one, and names keep the values out of every argv.
    readonly envKeys: readonly string[];
    readonly isolation?: TurnPlacement | undefined;
    // The conversation, stamped on the pane so the daemon tells a turn's processes apart; charset-guarded below.
    readonly owner?: string | undefined;
}

/** The turn's terminal, or undefined where tmux-run is not in the image (local dev, tests) or the id names no session. */
export const cursorTerminalOf = (
    sessionId: string,
    turn: Pick<CursorTerminal, "envKeys" | "isolation" | "owner">,
): CursorTerminal | undefined => {
    const session = agentSessionName(sessionId);
    return session === undefined || !tmuxRunEnabled() ? undefined : { session, sessionId, ...turn };
};

/**
 * Writes one command's run files and answers the line that runs it in the pane: `command` with its values, `said` as
 * the model wrote it (what the output filter reads, and what the pane's window is named for).
 */
export const paneCommand = (terminal: CursorTerminal, command: string, said: string): string => {
    const dir = mkdtempSync(join(runRootFor(terminal.isolation), "intentic-run-"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const agentFile = join(dir, "agent");
    writeRunFile(dir, "agent", `${PIPESTATUS_TRAP}${command}\n`);
    const owner = terminal.owner !== undefined && /^[A-Za-z0-9_-]+$/u.test(terminal.owner) ? `${WORKLOAD_ENV}=${terminal.owner} ` : "";
    const stamp = `${AGENT_SESSION_ENV}=${shellQuote(terminal.sessionId)} ${owner}`;
    writeRunFile(dir, "line", `${stamp}${paneHop(terminal.isolation)}${POLITE_PREFIX}${NO_PROMPTS}bash ${shellQuote(agentFile)}\n`);
    writeRunFile(dir, "said", said);
    writeRunFile(dir, "name", "cursor");
    return `${TMUX_RUN_BIN} ${envKeyFlags(terminal.envKeys)}-f ${shellQuote(join(dir, "line"))} ${terminal.session}`;
};
