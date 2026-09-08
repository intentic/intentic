import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { nsenterPrefix, type TurnPlacement } from "../../agents/worktrees/isolation.js";
import { AGENT_SESSION_ENV } from "../../platform/boot/container-owner.js";
import { WORKLOAD_ENV } from "../../platform/boot/leftovers.js";
import { redirectCommand } from "../../agents/worktrees/worktree-redirect.js";
import { resolveCommandSecrets, type SecretAccess } from "./agent-secrets.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { QUEUE_RUN_BIN, queueRunEnabled, TMUX_RUN_BIN } from "../../terminal/terminal-run.js";
import { type HeavyCommands, matchHeavyCommand } from "../../platform/resources/heavy-commands.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// Rewrites every Bash tool command through bin/tmux-run so it runs visibly in the `agent-<sdk session>` tmux session
// the terminal panel attaches to; subagent Bash calls land in the same session as extra windows.

// Off when the wrapper isn't baked into the image (local dev, tests) or the operator opts out.
export const tmuxRunEnabled = (): boolean => process.env["INTENTIC_AGENT_TMUX"] !== "0" && existsSync(TMUX_RUN_BIN);

const execFileAsync = promisify(execFile);

// A live (non-dead) pane means a command has not returned: a background job, a lingering build, or the user typing. No
// session or no tmux server means not busy; both are `list-panes` exiting non-zero.
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

// Window name from the Bash tool's `description`; same safe charset as session names since it lands unquoted in the
// shell line.
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

// Env var NAMES as `-e NAME` flags; tmux-run resolves each value itself, since the pane otherwise inherits the tmux
// server's stale env. Only valid identifiers pass through: unquoted in the shell line, values never appear in it.
const envKeyFlags = (envKeys: readonly string[]): string =>
    [...envKeys]
        .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .toSorted()
        .map((key) => `-e ${key} `)
        .join("");

// Demotes every agent command (nice +10, ionice); `bash -c` wraps it since `nice` execs a binary not a keyword.
const POLITE_PREFIX = "nice -n 10 ionice -c 2 -n 7 ";

// Bounds concurrent heavy commands via bin/queue-run, since demotion rations CPU but not memory. Spliced inside the
// namespace hop and the demotion, so the slot covers the whole forked tree.
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

// Wraps a whole command line behind the queue, for a caller that runs one command directly rather than rewriting an
// agent's. Same rules and the same queueRunEnabled standing-down; an unmatched command returns unchanged.
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
    // An isolated turn's Bash must land in the same tree as its Edit/Write:
    // - anchored: nsenter wraps the command inside the window
    // - unanchored: absolute paths in the command are rewritten into the worktree
    isolation?: TurnPlacement,
    // Stamped onto the pane command too, since tmux-forked processes inherit nothing from the CLI; charset-guarded.
    owner?: string,
    // Turn's secret registry, if any; resolved inline so its order versus the wrapper stays known.
    secrets?: SecretAccess,
    // Reads .intentic/config/heavy-commands.json per call; absent when this sandbox does not queue at all.
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
                        // Path rewrite runs first, on the agent's words; what follows names no workspace path of its
                        // own.
                        const redirected =
                            isolation !== undefined && isolation.anchor === undefined ? redirectCommand(tool.command, isolation.plan) : tool.command;
                        const command = redirected;
                        // A secret reference resolves into the executed line's value; `-c` below keeps the
                        // reference-form `command`.
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
                        // Rides the namespace hop so every forked process carries it; lets the daemon tell an
                        // agent-started run apart.
                        const stamp = `${AGENT_SESSION_ENV}=${shellQuote(input.session_id)} ${owner !== undefined && /^[A-Za-z0-9_-]+$/u.test(owner) ? `${WORKLOAD_ENV}=${owner} ` : ""}`;
                        // Matched against the agent's own `command`, never `executed` (a resolved secret) or the
                        // wrapped string.
                        const queue = await (async (): Promise<string> => {
                            try {
                                return heavy === undefined ? "" : queuePrefix(command, await heavy());
                            } catch {
                                return "";
                            }
                        })();
                        // Namespace hop and demotion sit inside the wrapper; the forked tree inherits both, tmux-run
                        // stays outside.
                        const inner =
                            isolation?.anchor !== undefined
                                ? `${stamp}${nsenterPrefix(isolation.anchor.pid, isolation.anchor.cwd)}${POLITE_PREFIX}${queue}bash -c ${shellQuote(executed)}`
                                : `${stamp}${POLITE_PREFIX}${queue}bash -c ${shellQuote(executed)}`;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                updatedInput: {
                                    ...(tool as Record<string, unknown>),
                                    // `-c` carries the command as written; cleaner matching reads it too, not the
                                    // wrapped line tmux-run executes.
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
