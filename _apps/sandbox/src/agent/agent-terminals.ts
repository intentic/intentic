import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { nsenterPrefix, type TurnPlacement } from "../agents/isolation.js";
import { redirectCommand } from "../agents/worktree-redirect.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { shellQuote, TMUX_RUN_BIN } from "../terminal/terminal-run.js";

// Rewrites every Bash tool command through bin/tmux-run (baked into the image), so the agent's shell
// commands run live-visible in `agent-<sdk session>` tmux sessions the terminal panel can attach to — the
// user watches (and can type into) the agent's terminals. Subagent Bash calls hit the same session-wide
// hook, so their commands land in the same session as extra windows.

// Off when the wrapper isn't baked in (local dev, tests) or the operator opts out.
export const tmuxRunEnabled = (): boolean => process.env["INTENTIC_AGENT_TMUX"] !== "0" && existsSync(TMUX_RUN_BIN);

const execFileAsync = promisify(execFile);

/* IS THE AGENT'S OWN SHELL STILL WORKING — asked before anything moves the files under it.
 *
 * Every Bash command runs in a window of this turn's tmux session (the rewrite below), and tmux-run sets
 * `remain-on-exit` from inside the pane, so a finished command leaves its window behind as a DEAD pane. A live
 * pane therefore means a command that has not returned: a background job the agent started, a build it left
 * running, or the user typing in the terminal panel — which are the same thing to this question.
 *
 * The parked-card rebase is the caller (agent.ts, agents/sync.ts). A rebase swaps files under whatever is
 * reading them, and the dirty-remainder commit it takes first would sweep a half-written file onto the branch;
 * neither failure announces itself, and the whole point of that rebase is to REMOVE a class of silent
 * surprise. So a busy shell simply skips it: the branch stays where it is and the land-time conflict flow is
 * still there behind it, exactly as on a turn that never asked.
 *
 * No session (the agent has run no command this turn) or no tmux server ⇒ not busy. Both are `list-panes`
 * exiting non-zero, and both mean the same thing: nothing of this turn's is running.
 */
export const agentShellBusy = async (sessionId: string): Promise<boolean> => {
    const session = agentSessionName(sessionId);
    if (session === undefined) {
        return false;
    }
    try {
        const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_dead}"]);
        return stdout.split("\n").some((pane) => pane.trim() === "0");
    } catch {
        return false;
    }
};

// tmux window name from the Bash tool's `description`, so the session's window list reads meaningfully.
// Same safe charset as session names (it lands in the rewritten shell line unquoted).
const windowSlug = (description: unknown): string => {
    if (typeof description !== "string") {
        return "run";
    }
    const slug = description
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 24);
    return slug === "" ? "run" : slug;
};

// Env var NAMES forwarded onto each command's tmux window (`-e NAME` — tmux-run resolves the value from its
// own environment, which the SDK subprocess passes down fresh each turn). The pane's shell otherwise inherits
// the tmux SERVER's env snapshot, so per-turn capability credentials would be missing or stale there; the
// value itself never appears in the rewritten command text, transcript, or pane logs. Only valid identifiers
// survive: these land unquoted in the shell line every Bash command flows through. A capability REMOVED after
// the server captured its var stays in the server env — forwarding only overrides per-window.
const envKeyFlags = (envKeys: readonly string[]): string =>
    [...envKeys]
        .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .toSorted()
        .map((key) => `-e ${key} `)
        .join("");

/* Every agent shell command runs DEMOTED — CPU nice +10, IO best-effort lowest — because the agent's builds
 * and test runs are exactly what has starved this container: a couple of concurrent turns spawning vitest
 * worker pools flat-lined the machine, the daemon's own loop went silent for tens of seconds, and the browser
 * declared the sandbox dead. Demotion costs an agent command nothing on an idle machine (priorities only bind
 * under contention) and keeps the control plane answering during exactly the bursts that used to take it out.
 * Wrapped in `bash -c` so a compound line (`cd x && make`) demotes as ONE tree — `nice` can exec a binary,
 * not a shell keyword. */
const POLITE_PREFIX = "nice -n 10 ionice -c 2 -n 7 ";

export const bashTmuxHooks = (
    envKeys: readonly string[] = [],
    /* An isolated turn's Bash must land in the same tree as its Edit/Write, or the two tools disagree about
     * what /work is — the agent edits its worktree and `sed -i` on the same path rewrites the shared tree.
     * Both roads to that agreement start here, because a pane is forked by the tmux SERVER, which is pinned to
     * the daemon's namespace (isolation.ts names it to bin/tmux-run, which hops there before it can ever fork
     * one), and the pane's own command line is the only place that can diverge from it:
     *
     *  - anchored: nsenter wraps the command INSIDE the window, leaving the server, its socket, and the
     *    terminals panel's list/attach exactly as they are;
     *  - unanchored: the absolute paths in the command line are rewritten into the worktree instead
     *    (worktree-redirect.ts), which is the same substitution the mounts would have made.
     */
    isolation?: TurnPlacement,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const envFlags = envKeyFlags(envKeys);
    return {
        PreToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                            return {};
                        }
                        const tool = input.tool_input as { command?: unknown; description?: unknown };
                        if (typeof tool.command !== "string" || tool.command.startsWith(TMUX_RUN_BIN)) {
                            return {};
                        }
                        const session = agentSessionName(input.session_id);
                        if (session === undefined) {
                            return {};
                        }
                        // The path rewrite goes FIRST, on the agent's own words: everything added below is the
                        // daemon's (tmux-run, the namespace hop, the pane name) and names no workspace path of
                        // its own, so rewriting after would scan text that can only produce false matches.
                        const command =
                            isolation !== undefined && isolation.anchor === undefined ? redirectCommand(tool.command, isolation.plan) : tool.command;
                        // The namespace hop goes inside the tmux wrapper: tmux-run itself must stay out here
                        // where the server and the pane logs are. The polite prefix goes with the command
                        // (inside the hop), so the whole build/test tree it forks inherits the demotion.
                        const inner =
                            isolation?.anchor !== undefined
                                ? `${nsenterPrefix(isolation.anchor.pid, isolation.anchor.cwd)}${POLITE_PREFIX}bash -c ${shellQuote(command)}`
                                : `${POLITE_PREFIX}bash -c ${shellQuote(command)}`;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                updatedInput: {
                                    ...(tool as Record<string, unknown>),
                                    /* `-c` carries the command AS THE AGENT WROTE IT, alongside the wrapped one
                                     * tmux-run actually executes, because everything the cleaners are asked
                                     * about is a property of the agent's line and none of it survives wrapping:
                                     * the ledger's "which un-cleaned commands are worth a handler" list showed
                                     * `nsenter --mount=/proc/<pid>/ns/mnt … nice -n 10 ionice …` for every row —
                                     * ~100 characters of daemon boilerplate before the first real word, and a
                                     * per-turn pid making every row unique. Cleaner MATCHING reads it too, so
                                     * `nice`/`ionice`/`bash` can no longer stand in for the agent's own verb. */
                                    command: `${TMUX_RUN_BIN} ${envFlags}-c ${shellQuote(command)} ${session} ${shellQuote(inner)} ${windowSlug(tool.description)}`,
                                },
                            },
                        };
                    },
                ],
            },
        ],
    };
};
