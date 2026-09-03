import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { nsenterPrefix, type TurnPlacement } from "../agents/isolation.js";
import { AGENT_SESSION_ENV } from "../platform/container-owner.js";
import { WORKLOAD_ENV } from "../platform/leftovers.js";
import { redirectCommand } from "../agents/worktree-redirect.js";
import { resolveCommandSecrets, type SecretAccess } from "./agent-secrets.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { QUEUE_RUN_BIN, queueRunEnabled, TMUX_RUN_BIN } from "../terminal/terminal-run.js";
import { type HeavyCommands, matchHeavyCommand } from "../platform/heavy-commands.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Rewrites every Bash tool command through bin/tmux-run (baked into the image), so the agent's shell
// commands run live-visible in `agent-<sdk session>` tmux sessions the terminal panel can attach to, the
// user watches (and can type into) the agent's terminals. Subagent Bash calls hit the same session-wide
// hook, so their commands land in the same session as extra windows.

// Off when the wrapper isn't baked in (local dev, tests) or the operator opts out.
export const tmuxRunEnabled = (): boolean => process.env["INTENTIC_AGENT_TMUX"] !== "0" && existsSync(TMUX_RUN_BIN);

const execFileAsync = promisify(execFile);

/* IS THE AGENT'S OWN SHELL STILL WORKING, asked before anything moves the files under it.
 *
 * Every Bash command runs in a window of this turn's tmux session (the rewrite below), and tmux-run sets
 * `remain-on-exit` from inside the pane, so a finished command leaves its window behind as a DEAD pane. A live
 * pane therefore means a command that has not returned: a background job the agent started, a build it left
 * running, or the user typing in the terminal panel, which are the same thing to this question.
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

// Env var NAMES forwarded onto each command's tmux window (`-e NAME`, tmux-run resolves the value from its
// own environment, which the SDK subprocess passes down fresh each turn). The pane's shell otherwise inherits
// the tmux SERVER's env snapshot, so per-turn capability credentials would be missing or stale there; the
// value itself never appears in the rewritten command text, transcript, or pane logs. Only valid identifiers
// survive: these land unquoted in the shell line every Bash command flows through. A capability REMOVED after
// the server captured its var stays in the server env, forwarding only overrides per-window.
const envKeyFlags = (envKeys: readonly string[]): string =>
    [...envKeys]
        .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .toSorted()
        .map((key) => `-e ${key} `)
        .join("");

/* Every agent shell command runs DEMOTED. CPU nice +10, IO best-effort lowest, because the agent's builds
 * and test runs are exactly what has starved this container: a couple of concurrent turns spawning vitest
 * worker pools flat-lined the machine, the daemon's own loop went silent for tens of seconds, and the browser
 * declared the sandbox dead. Demotion costs an agent command nothing on an idle machine (priorities only bind
 * under contention) and keeps the control plane answering during exactly the bursts that used to take it out.
 * Wrapped in `bash -c` so a compound line (`cd x && make`) demotes as ONE tree, `nice` can exec a binary,
 * not a shell keyword. */
const POLITE_PREFIX = "nice -n 10 ionice -c 2 -n 7 ";

/* AND THE ONES DEMOTION IS NOT ENOUGH FOR, put behind bin/queue-run so only so many run at once.
 *
 * The demotion above rations CPU, and the thing a monorepo fan-out actually exhausts is MEMORY, which no
 * scheduler class rations: a niced vitest worker pool occupies exactly as much of the cgroup as an un-niced
 * one. platform/heavy-commands.ts holds the measurement and the rules; this is only where the wrapper is
 * spliced in.
 *
 * INSIDE the namespace hop and INSIDE the demotion, so the slot covers the whole tree the command forks and
 * the wait itself is niced: queue-run holds an flock on an inherited descriptor and execs, so what the kernel
 * releases the slot on is the last process of that tree exiting. Nothing about the agent's own line is
 * touched — the `-c` copy below still carries the agent's words, so the cleaners and the use ledger read the
 * verb the agent typed rather than this wrapper.
 *
 * A config value reaches a shell line here, so `pool` and `label` are quoted: the file is agent-writable
 * (that is the point of it), and everything from it is treated as text rather than as shell. The numbers are
 * integers the schema has already bounded. */
const queuePrefix = (command: string, config: HeavyCommands | undefined): string => {
    if (config === undefined) {
        return "";
    }
    const match = matchHeavyCommand(command, config);
    if (match === undefined) {
        return "";
    }
    const flags = [
        `--pool ${shellQuote(match.pool)}`,
        `--limit ${String(match.limit)}`,
        `--wait ${String(config.waitSeconds)}`,
        `--memory-gate ${String(config.memoryGateSeconds)}`,
        `--label ${shellQuote(match.id)}`,
    ].join(" ");
    return `${QUEUE_RUN_BIN} ${flags} -- `;
};

/* A WHOLE COMMAND LINE BEHIND THE QUEUE, for a caller that runs one command rather than rewriting an agent's:
 * the post-land check (workspace/verify-deps.ts). The same rules, the same prefix, and the same standing-down
 * (`queueRunEnabled`: no wrapper on this image, or the operator opted out); a command the rules do not call
 * heavy comes back as it was. The reader is called per command, for the reason bashTmuxHooks gives. */
export const queueWhole =
    (heavy: () => Promise<HeavyCommands>) =>
    async (command: string): Promise<string> => {
        if (!queueRunEnabled()) {
            return command;
        }
        const prefix = queuePrefix(command, await heavy());
        return prefix === "" ? command : `${prefix}bash -c ${shellQuote(command)}`;
    };

export const bashTmuxHooks = (
    envKeys: readonly string[] = [],
    /* An isolated turn's Bash must land in the same tree as its Edit/Write, or the two tools disagree about
     * what /work is, the agent edits its worktree and `sed -i` on the same path rewrites the shared tree.
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
    /* The conversation this turn belongs to, the same owner the SDK subprocess is stamped with (agent.ts
     * workloadStamp). Carried onto every pane command too, because a pane's processes are forked by the tmux
     * SERVER and inherit nothing from the CLI: without this a `nohup`d survivor of a killed session is a
     * stamped-nowhere process nothing can attribute. The reaper's whole licence over pane trees is this stamp
     * (platform/reaper.ts). Charset-guarded because it lands unquoted-adjacent in the shell
     * line every Bash command flows through. */
    owner?: string,
    /* The turn's secret registry, when it has one. Resolution rides INSIDE this rewrite rather than as its own
     * PreToolUse matcher because two rewriters of one command must compose in a KNOWN order, hook order across
     * separate matchers is the SDK's, and the order matters twice: the reference must be resolved before the
     * command is quoted into the wrapper, and the `-c` copy (what the cleaners and the use ledger read) must
     * keep the agent's reference-form line. The no-tmux configuration gets the standalone hook instead
     * (agent-secrets.ts secretCommandHooks). */
    secrets?: SecretAccess,
    /* Reads .intentic/config/heavy-commands.json, or absent when this sandbox does not queue at all (no
     * queue-run baked into the image, the operator opted out: terminal-run.ts queueRunEnabled).
     *
     * A READER rather than a value, and called per command rather than per turn, because the file is one the
     * owner and the agent both edit by hand. Re-reading it means an edit takes effect on the next command
     * instead of the next daemon restart, which is the difference between a knob someone turns while watching
     * the box struggle and one they find out about afterwards. It is a few kilobytes the page cache already
     * holds; the command it gates costs minutes. */
    heavy?: () => Promise<HeavyCommands>,
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
                        const redirected =
                            isolation !== undefined && isolation.anchor === undefined ? redirectCommand(tool.command, isolation.plan) : tool.command;
                        const command = redirected;
                        /* The secret exit (agent-secrets.ts): `{{secret:name}}` becomes the stored value in the
                         * line the pane EXECUTES, while `-c` below keeps the reference-form `command`, so the
                         * cleaners, the ledger and the pane's window all speak the agent's own words. The
                         * resolved value does land in the pane's command line and its logs, which the owner can
                         * open, the owner's own secret, behind the same door as the Secrets view's reveal. */
                        let executed = command;
                        if (secrets !== undefined) {
                            const resolved = await resolveCommandSecrets(command, secrets);
                            if ("refusal" in resolved) {
                                return {
                                    hookSpecificOutput: {
                                        hookEventName: "PreToolUse",
                                        permissionDecision: "deny",
                                        permissionDecisionReason: resolved.refusal,
                                    },
                                };
                            }
                            executed = resolved.command;
                        }
                        /* WHATEVER THIS COMMAND FORKS IS BORN KNOWING IT CAME FROM A CONVERSATION. An env prefix
                         * on the command itself because it must ride INSIDE the namespace hop, on the process
                         * tree, so a server the agent starts, and the children of that, carry it however deep
                         * they go and whatever spawned them.
                         *
                         * What reads it is the daemon (platform/container-owner.ts), about ITSELF: this repo is
                         * the sandbox, so `tsx src/main.ts` to see a change work is an ordinary thing for an
                         * agent to run, and twice on 2026-08-11 that second daemon's first sweep killed every
                         * turn in flight. A daemon that can see it was started from a conversation knows it is a
                         * run of the code rather than this sandbox's daemon, and claims nothing. */
                        const stamp = `${AGENT_SESSION_ENV}=${shellQuote(input.session_id)} ${owner !== undefined && /^[A-Za-z0-9_-]+$/u.test(owner) ? `${WORKLOAD_ENV}=${owner} ` : ""}`;
                        /* Matched on the agent's own line: `command`, not `executed` (a resolved secret must
                         * never reach a regex or the queue's label) and not the wrapped string (the daemon's
                         * own `nice`/`nsenter` boilerplate would otherwise satisfy rules of its own).
                         *
                         * A failure to read or match must not cost the command: an unreadable file already
                         * falls back to the shipped defaults inside the store, and anything thrown beyond that
                         * leaves the queue out of the line entirely rather than failing the tool call. */
                        const queue = await (async (): Promise<string> => {
                            try {
                                return heavy === undefined ? "" : queuePrefix(command, await heavy());
                            } catch {
                                return "";
                            }
                        })();
                        // The namespace hop goes inside the tmux wrapper: tmux-run itself must stay out here
                        // where the server and the pane logs are. The polite prefix goes with the command
                        // (inside the hop), so the whole build/test tree it forks inherits the demotion.
                        const inner =
                            isolation?.anchor !== undefined
                                ? `${stamp}${nsenterPrefix(isolation.anchor.pid, isolation.anchor.cwd)}${POLITE_PREFIX}${queue}bash -c ${shellQuote(executed)}`
                                : `${stamp}${POLITE_PREFIX}${queue}bash -c ${shellQuote(executed)}`;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                updatedInput: {
                                    ...(tool as Record<string, unknown>),
                                    /* `-c` carries the command AS THE AGENT WROTE IT, alongside the wrapped one
                                     * tmux-run actually executes, because everything the cleaners are asked
                                     * about is a property of the agent's line and none of it survives wrapping:
                                     * the ledger's "which un-cleaned commands are worth a handler" list showed
                                     * `nsenter --mount=/proc/<pid>/ns/mnt … nice -n 10 ionice …` for every row,
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
