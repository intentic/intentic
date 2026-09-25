import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { forkedExec } from "@intentic/scaffold";
import { nsenterPrefix, type TurnPlacement } from "../../agents/worktrees/isolation.js";
import { AGENT_SESSION_ENV } from "../../platform/boot/container-owner.js";
import { WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { redirectCommand } from "../../agents/worktrees/worktree-redirect.js";
import { resolveCommandSecrets, type SecretAccess } from "../../secrets/secret-access.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { QUEUE_RUN_BIN, queueRunEnabled, TMUX_RUN_BIN } from "../../terminal/terminal-run.js";
import { OFFLOAD_RUN_BIN } from "../../offload/offload-prefix.js";
import { type HeavyCommands, heavyEnvPrefix } from "../../platform/resources/heavy-commands.js";
import { queueArgs, ruleById } from "@intentic/constants/heavy-rules";
import { shellPrefix } from "../../workload/workload-class.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { type BackgroundJob, backgroundJobOf, type BackgroundJobSeed, jobCommandLine, openBackgroundJob, stopBackgroundJob } from "./background-jobs.js";
import { turnRunOf } from "../../agents/actor/conversation-holdings.js";

// Rewrites every Bash tool command through bin/tmux-run so it runs visibly in the `agent-<sdk session>` tmux session
// the terminal panel attaches to; subagent Bash calls land in the same session as extra windows.
//
// A `run_in_background: true` call is rewritten one step further, through tmux-run's `-b`: its pane must survive this
// turn's CLI exiting, which is what the harness promises and what the ordinary path silently broke
// (background-jobs.ts says how).

// Off when the wrapper isn't baked into the image (local dev, tests) or the operator opts out.
export const tmuxRunEnabled = (): boolean => process.env["INTENTIC_AGENT_TMUX"] !== "0" && existsSync(TMUX_RUN_BIN);

// A live (non-dead) pane means a command has not returned: a background job, a lingering build, or the user typing. No
// session or no tmux server means not busy; both are `list-panes` exiting non-zero.
export const agentShellBusy = async (sessionId: string): Promise<boolean> => {
    const session = agentSessionName(sessionId);
    if (session === undefined) {
        return false;
    }
    try {
        const { stdout } = await forkedExec("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_dead}"]);
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

// Puts every agent command in the `command` class (workload-class.ts): demoted, and ranked for the OOM killer above every
// runtime; `bash` runs the command's file since `nice` execs a binary, not a keyword. Panes hang off the tmux server, so
// no runtime's class reaches them by fork.
const POLITE_PREFIX = shellPrefix({ class: "command" });

// Leaves the last pipeline's per-stage statuses where bin/tmux-run's pane exports INTENTIC_PIPESTATUS_FILE. An EXIT
// trap on the command's first line: its text, line numbers and exit status stay the agent's own.
export const PIPESTATUS_TRAP = `trap 'printf "%s " "\${PIPESTATUS[@]}" 2>/dev/null >"\${INTENTIC_PIPESTATUS_FILE:-/dev/null}"' EXIT; `;

// Heavy programs are judged as they start, by what they are (platform/resources/heavy-commands.ts heavyEnvPrefix): the
// line only carries the table down. Queueing is only on where queue-run is, and a program that matches keeps its
// toolchain class whether or not it queues.
const queueRunOf = (): string | undefined => (queueRunEnabled() ? QUEUE_RUN_BIN : undefined);

// The check after landing's queue prefix: the daemon knows which line that is, so it takes the `repo-verify` rule by
// name rather than recognising it; "" when that rule is disabled or nothing queues. The line waits for its slot here, so
// the time it waits is never charged to its own ceiling (workspace/deps/verify-deps.ts).
export const queuePrefixFor =
    (heavy: () => Promise<HeavyCommands>) =>
    async (_command: string): Promise<string> => {
        const config = await heavy();
        const rule = ruleById(config, "repo-verify");
        if (!queueRunEnabled() || !config.queue || rule === undefined) {
            return "";
        }
        const match = {
            id: rule.id,
            pool: rule.pool ?? config.defaultPool,
            limit: rule.limit ?? config.limit,
            maxHold: rule.maxHoldSeconds ?? config.maxHoldSeconds,
            onDeadline: rule.onDeadline ?? config.onDeadline,
        };
        return `${QUEUE_RUN_BIN} ${queueArgs(match, config).map(shellQuote).join(" ")} -- ${shellPrefix({ class: "toolchain" })}`;
    };

// A whole line run under the heavy table, for a caller that runs one command directly rather than rewriting an agent's
// (a runner running a line its parent offloaded): its programs queue here as they start, and none goes on elsewhere.
export const queueWhole =
    (heavy: () => Promise<HeavyCommands>) =>
    async (command: string): Promise<string> =>
        `${heavyEnvPrefix(await heavy(), { queueRun: queueRunOf() })}bash -c ${shellQuote(command)}`;

// The start row is written inside the live turn, since the settle that adopts the job runs after the record closes.
const startJob = (
    seed: BackgroundJobSeed,
    call: { readonly command: string; readonly session: string; readonly description: unknown; readonly toolUseId: string },
): BackgroundJob | undefined => {
    const job = openBackgroundJob(seed, {
        command: call.command,
        session: call.session,
        ...(typeof call.description === "string" ? { description: call.description } : {}),
        toolUseId: call.toolUseId,
    });
    if (job !== undefined) {
        turnRunOf(seed.conversations, job.conversationId)?.note({
            role: "notice",
            text: `Background job: ${job.label}`,
            backgroundJob: { id: job.id, label: job.label, command: jobCommandLine(call.command), startedAt: job.startedAt },
        });
    }
    return job;
};

// The CLI's own ways to stop a background task by the id its Bash call returned, across its renames.
const TASK_STOP_TOOLS = "TaskStop|KillShell|KillBash";

// The stop the CLI performs cannot reach a job: it signals tmux-run, which under `-b` must survive that very signal (it
// is also how the turn's CLI exits), so the pane ran on while the agent was told "Successfully stopped task". After a
// stop that names one of this conversation's jobs, the job is ended for real.
const taskStopHooks = (jobs: BackgroundJobSeed): HookCallbackMatcher[] => [
    {
        matcher: TASK_STOP_TOOLS,
        hooks: [
            async (input) => {
                if (input.hook_event_name !== "PostToolUse") {
                    return {};
                }
                const tool = input.tool_input as { task_id?: unknown; shell_id?: unknown };
                const id = typeof tool.task_id === "string" ? tool.task_id : typeof tool.shell_id === "string" ? tool.shell_id : undefined;
                const job = id === undefined ? undefined : backgroundJobOf(jobs.conversations, jobs.conversationId, id);
                if (job !== undefined) {
                    // A job this turn's CLI can name was started in this turn, so no watch holds it yet to disarm.
                    await stopBackgroundJob(jobs.conversations, job, "agent");
                }
                return {};
            },
        ],
    },
];

export const bashTmuxHooks = (
    envKeys: readonly string[] = [],
    // An isolated turn's Bash must land in the same tree as its Edit/Write:
    // - anchored: nsenter wraps the command inside the window
    // - uncheckpointed: absolute paths in the command are rewritten into the worktree
    isolation?: TurnPlacement,
    // Stamped onto the pane command too, since tmux-forked processes inherit nothing from the CLI; charset-guarded.
    owner?: string,
    // Turn's secret registry, if any; resolved inline so its order versus the wrapper stays known.
    secrets?: SecretAccess,
    // Reads .intentic/config/heavy-commands.json per call; absent when this sandbox does not queue at all.
    heavy?: () => Promise<HeavyCommands>,
    // Which heavy rules' lines run on a runner instead (settings `offload.commands`), read per call like the rules.
    offload?: () => Promise<Readonly<Record<string, string>>>,
    // Conversation and routing a background job's completion wakes; absent leaves such a job ordinary, so it still
    // dies with the turn — a conversationless turn has nowhere to deliver the wake anyway.
    jobs?: BackgroundJobSeed,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const envFlags = envKeyFlags(envKeys);
    return {
        ...(jobs === undefined ? {} : { PostToolUse: taskStopHooks(jobs) }),
        PreToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                            return {};
                        }
                        const tool = input.tool_input as { command?: unknown; description?: unknown; run_in_background?: unknown };
                        if (typeof tool.command !== "string" || tool.command.startsWith(TMUX_RUN_BIN)) {
                            return {};
                        }
                        const session = agentSessionName(input.session_id);
                        if (session === undefined) {
                            return {};
                        }
                        // Path rewrite runs first, on the agent's words; what follows names no workspace path of its
                        // own.
                        const command =
                            isolation !== undefined && isolation.anchor === undefined ? redirectCommand(tool.command, isolation.plan) : tool.command;
                        // A secret reference resolves into the executed line's value; the filter is told the
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
                        // The table every program of the line is judged by as it starts; a line that resolved a
                        // secret offloads nothing, since the value would travel to another machine.
                        const heavyEnv = await (async (): Promise<string> => {
                            try {
                                if (heavy === undefined) {
                                    return "";
                                }
                                const routes = executed === command ? ((await offload?.().catch(() => ({}))) ?? {}) : {};
                                return heavyEnvPrefix(await heavy(), { queueRun: queueRunOf(), offloadRun: OFFLOAD_RUN_BIN, offload: routes });
                            } catch {
                                return "";
                            }
                        })();
                        // Filed first, so the flag and the registry entry cannot disagree about which dir holds this
                        // job's completion. A dir that cannot be made leaves the call ordinary rather than failing it.
                        const job =
                            jobs === undefined || tool.run_in_background !== true
                                ? undefined
                                : startJob(jobs, { command, session, description: tool.description, toolUseId: input.tool_use_id });
                        // THE COMMAND TRAVELS BY FILE. `pkill -f` and `pgrep -f` match every process's whole command
                        // line, so a pattern that sat in any wrapper's argv (the CLI's shell, tmux-run, the pane's
                        // shell) killed the agent's own call. Written to files, it is in no argv at all: the CLI runs
                        // `tmux-run -f <dir>/line <session>`, the pane runs `bash <dir>/agent`, and the window name and
                        // the words the output filter reads sit beside them.
                        const dir = job?.dir ?? mkdtempSync(join(tmpdir(), "intentic-run-"));
                        mkdirSync(dir, { recursive: true, mode: 0o700 });
                        const agentFile = join(dir, "agent");
                        writeFileSync(agentFile, `${PIPESTATUS_TRAP}${executed}\n`, { mode: 0o600 });
                        const run = `${POLITE_PREFIX}${heavyEnv}bash ${shellQuote(agentFile)}`;
                        // Namespace hop and demotion sit inside the wrapper; the forked tree inherits both, tmux-run
                        // stays outside.
                        const inner =
                            isolation?.anchor !== undefined ? `${stamp}${nsenterPrefix(isolation.anchor.pid, isolation.anchor.cwd)}${run}` : `${stamp}${run}`;
                        writeFileSync(join(dir, "line"), `${inner}\n`, { mode: 0o600 });
                        writeFileSync(join(dir, "said"), command, { mode: 0o600 });
                        writeFileSync(join(dir, "name"), windowSlug(tool.description), { mode: 0o600 });
                        const jobFlag = job === undefined ? "" : `-b ${shellQuote(job.dir)} `;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                updatedInput: {
                                    ...(tool as Record<string, unknown>),
                                    command: `${TMUX_RUN_BIN} ${envFlags}${jobFlag}-f ${shellQuote(join(dir, "line"))} ${session}`,
                                },
                            },
                        };
                    },
                ],
            },
        ],
    };
};
