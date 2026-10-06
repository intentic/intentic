import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { forkedExec } from "@intentic/base/git";
import { z } from "zod";
import { nsenterPrefix, type TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { AGENT_SESSION_ENV } from "../../system/boot/container-owner.js";
import { WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { redirectCommand } from "../../conversations/worktrees/worktree-redirect.js";
import { resolveCommandSecrets, type SecretAccess } from "../../secrets/secret-access.js";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { TMUX_RUN_BIN } from "../../terminal/terminal-run.js";
import { isNoTmuxTarget } from "../../terminal/tmux-server.js";
import { OFFLOAD_RUN_BIN } from "../../offload/offload-prefix.js";
import { type HeavyCommands, heavyEnvPrefix, QUEUE_RUN_BIN, queueRunEnabled } from "../../workload/heavy-commands.js";
import { shellPrefix } from "../../workload/workload-class.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import {
    type BackgroundJob,
    backgroundJobOf,
    type BackgroundJobSeed,
    fileOverrunCommand,
    jobCommandLine,
    jobOutputPath,
    jobShellId,
    openBackgroundJob,
    stopBackgroundJob,
} from "./jobs/background-jobs.js";
import { followRun } from "./jobs/input-wait-follow.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";

// Rewrites every Bash tool command through bin/tmux-run so it runs visibly in the `agent-<sdk session>` tmux session
// the terminal panel attaches to; subagent Bash calls land in the same session as extra windows.
//
// A `run_in_background: true` call is rewritten one step further, through tmux-run's `-b`: its pane must survive this
// turn's CLI exiting, which is what the harness promises and what the ordinary path silently broke
// (background-jobs.ts says how).

// Off when the wrapper isn't baked into the image (local dev, tests) or the operator opts out.
export const tmuxRunEnabled = (): boolean => process.env["INTENTIC_AGENT_TMUX"] !== "0" && existsSync(TMUX_RUN_BIN);

// A live (non-dead) pane means a command has not returned: a background job, a lingering build, or the user typing. No
// session or no tmux server means not busy; any other failed listing rejects, since it answered neither way.
export const agentShellBusy = async (sessionId: string): Promise<boolean> => {
    const session = agentSessionName(sessionId);
    if (session === undefined) {
        return false;
    }
    try {
        const { stdout } = await forkedExec("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_dead}"]);
        return stdout.split("\n").some((pane) => pane.trim() === "0");
    } catch (error) {
        if (isNoTmuxTarget(error)) {
            return false;
        }
        throw error;
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

// Two prompts that, reproduced in an agent's pane on 2026-10-04, wait there for good, turned off at the source. The pane's
// terminal is the command's stdin, so npx asks "Ok to proceed? (y)" before installing a package the project lacks, and
// git asks for a username on /dev/tty for a host with no stored credential; nothing in the turn can answer either, and
// git's question never even reaches the captured output. Off, npx fails at once naming the missing package and git
// says "terminal prompts disabled": answers an agent can act on. A command that sets either itself keeps its own, and
// `npx --yes` still installs. Prompts that did not reproduce (pagers: stdout is a pipe; corepack: it did not ask) are
// left alone; input-wait.ts catches whatever asks anyway.
export const NO_PROMPTS = "env npm_config_yes=false GIT_TERMINAL_PROMPT=0 ";

// Leaves the last pipeline's per-stage statuses where bin/tmux-run's pane exports INTENTIC_PIPESTATUS_FILE. An EXIT
// trap on the command's first line: its text, line numbers and exit status stay the agent's own.
export const PIPESTATUS_TRAP = `trap 'printf "%s " "\${PIPESTATUS[@]}" 2>/dev/null >"\${INTENTIC_PIPESTATUS_FILE:-/dev/null}"' EXIT; `;

// Heavy programs are judged as they start, by what they are (workload/heavy-commands.ts heavyEnvPrefix): the
// line only carries the table down. Queueing is only on where queue-run is, and a program that matches keeps its
// toolchain class whether or not it queues.
const queueRunOf = (): string | undefined => (queueRunEnabled() ? QUEUE_RUN_BIN : undefined);

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

// The Bash tool's own timeout when a call names none, and the longest it accepts, in ms.
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
// What bin/tmux-run returns early by when nothing else is said, and the margin it keeps under the call's own timeout.
const SOFT_TIMEOUT_S = 110;
const SOFT_MARGIN_S = 10;

/**
 * Seconds bin/tmux-run waits on a foreground call before returning early, for a call that asked for more time than the
 * default; undefined leaves its 110. A shorter timeout keeps 110 too, so the CLI's own kill still ends the command at the
 * time the agent set, as it asked.
 */
export const softTimeoutOf = (timeoutMs: number | undefined): number | undefined => {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= BASH_DEFAULT_TIMEOUT_MS) {
        return undefined;
    }
    return Math.max(SOFT_TIMEOUT_S, Math.floor(Math.min(timeoutMs, BASH_MAX_TIMEOUT_MS) / 1000) - SOFT_MARGIN_S);
};

// What this module reads of a Bash call beyond its command, each field absent when the CLI sent something else.
const CallFieldsSchema = z.object({
    description: z.string().optional().catch(undefined),
    timeout: z.number().optional().catch(undefined),
});

// A Bash call's result as the CLI hands it to PostToolUse: its stdout, or the text itself in an older shape.
const BashResultSchema = z.union([z.string(), z.object({ stdout: z.string() }).transform((result) => result.stdout)]).catch("");

// The line bin/tmux-run ends an early return with, while the command runs on in its pane.
const STILL_RUNNING = "--- command still running in tmux window ";

// The line bin/tmux-run puts before it when the call came back because the command sits at a prompt (input-wait.ts).
const WAITING_FOR_INPUT = /^--- waiting for input: (.+)$/mu;

// What the agent is told of a call that came back early and was filed as a job: the id to wait on, and what not to do.
// One that came back at a prompt is told that waiting is what not to do: nothing in its turn can type into a pane.
export const overrunNote = (job: BackgroundJob, waiting?: string): string =>
    waiting === undefined
        ? `That command is still running, now as background job ${job.id}. Wait for it with the \`wait\` tool (target "${job.id}"), which returns when it exits with its exit code and output tail; do not poll its log with sleep or re-run it beside the live one. Full output so far: ${jobOutputPath(job)}`
        : `That command is waiting for input: ${waiting} is blocked reading its terminal and nothing has moved since, so it will sit there until something types into it, and nothing in your turn can. It is still running as background job ${job.id}: stop it with TaskStop (task_id "${job.id}"), then run it so it cannot ask (a flag that answers for it such as --yes or --no-input, its answer piped in, or prompting turned off: npm_config_yes, GIT_TERMINAL_PROMPT=0). If only a person can answer (a password, a one-time code), hand them the terminal with request_help instead. A \`| tail\` or \`| head\` after it holds back the question itself until the command exits. Output so far: ${jobOutputPath(job)}`;

// A foreground call on its way to the pane, kept until its result shows whether it came back early.
interface ForegroundCall {
    readonly dir: string;
    readonly command: string;
    readonly session: string;
    readonly description: string | undefined;
    readonly startedAt: number;
    // Stops following it for an input wait; a call filed as a job is followed on by its job.
    readonly unfollow: () => void;
}

// Beside the line, how long tmux-run waits on this call before returning early; and the call itself, kept for its result
// where a job could be filed for it. Followed meanwhile, so a call sitting at a prompt comes back as soon as that is
// clear rather than at its soft timeout: the marker it is followed for is what tmux-run returns on.
const holdForeground = (
    call: Omit<ForegroundCall, "unfollow"> & { readonly toolUseId: string; readonly timeoutMs: number | undefined },
    foreground: Map<string, ForegroundCall> | undefined,
): void => {
    const soft = softTimeoutOf(call.timeoutMs);
    if (soft !== undefined) {
        writeFileSync(join(call.dir, "soft"), `${String(soft)}\n`, { mode: 0o600 });
    }
    if (foreground !== undefined) {
        foreground.set(call.toolUseId, { ...call, unfollow: followRun(call.dir) });
    }
};

// A foreground call that came back early becomes a job the agent waits on (fileOverrunCommand). Only calls this turn's
// PreToolUse sent to a pane are looked at, and each once.
const overrunHooks = (jobs: BackgroundJobSeed, foreground: Map<string, ForegroundCall>): HookCallbackMatcher => ({
    matcher: "Bash",
    hooks: [
        async (input) => {
            if (input.hook_event_name !== "PostToolUse") {
                return {};
            }
            const call = foreground.get(input.tool_use_id);
            foreground.delete(input.tool_use_id);
            if (call === undefined) {
                return {};
            }
            const result = BashResultSchema.parse(input.tool_response);
            // Filed before the call lets go, so the job takes over what the call's follower already saw.
            const job = result.includes(STILL_RUNNING) ? fileOverrunCommand(jobs, { ...call, toolUseId: input.tool_use_id }) : undefined;
            call.unfollow();
            if (job === undefined) {
                return {};
            }
            turnRunOf(jobs.conversations, job.conversationId)?.note({
                role: "notice",
                text: `Background job: ${job.label}`,
                backgroundJob: { id: job.id, label: job.label, command: jobCommandLine(call.command), startedAt: job.startedAt },
            });
            return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: overrunNote(job, WAITING_FOR_INPUT.exec(result)?.[1]) } };
        },
    ],
});

// The CLI's own ways to stop a background task by the id its Bash call returned, across its renames.
const TASK_STOP_TOOLS = "TaskStop|KillShell|KillBash";

// What a stop call names, across the CLI's renames of its field; parsed, since the CLI's input is not this module's type.
const StopCallSchema = z
    .object({
        task_id: z.string().optional().catch(undefined),
        shell_id: z.string().optional().catch(undefined),
    })
    .catch({});

// The id a stop call names.
const stopTarget = (input: z.infer<typeof StopCallSchema>): string | undefined => input.task_id ?? input.shell_id;

// A stop call's two hooks: the one that ends a job the CLI cannot name, and the one that ends a job the CLI only signals.
interface TaskStopHooks {
    readonly pre: HookCallbackMatcher;
    readonly post: HookCallbackMatcher;
}

// The stop the CLI performs cannot reach a job: it signals tmux-run, which under `-b` must survive that very signal (it
// is also how the turn's CLI exits), so the pane ran on while the agent was told "Successfully stopped task". After a
// stop that names one of this conversation's jobs, the job is ended for real.
//
// And a job the CLI never knew it cannot stop at all: a foreground call filed as a job when it ran past its time
// (fileOverrunCommand) has only the sandbox's id, which is the one the agent is told to use, and the CLI answered "No task
// found" and left it running (2026-10-04). A stop naming an id the CLI does not hold is carried out here, before the CLI
// sees it, and the answer is the call's result. A job an earlier turn's ending handed to a watch keeps that watch, as on
// the CLI's own path: the stop's exit then wakes the conversation once, saying it ended.
const taskStopHooks = (jobs: BackgroundJobSeed): TaskStopHooks => ({
    pre: {
        matcher: TASK_STOP_TOOLS,
        hooks: [
            async (input) => {
                if (input.hook_event_name !== "PreToolUse") {
                    return {};
                }
                const id = stopTarget(StopCallSchema.parse(input.tool_input));
                const job = id === undefined ? undefined : backgroundJobOf(jobs.conversations, jobs.conversationId, id);
                if (job === undefined || jobShellId(jobs.conversations, job) === id) {
                    return {};
                }
                const stopped = await stopBackgroundJob(jobs.conversations, job, "agent");
                return {
                    hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason: stopped
                            ? `Stopped background job ${job.id}: the sandbox ended it itself, since the CLI never knew this id, and it exited 143 (SIGTERM). Nothing more to stop.`
                            : `Background job ${job.id} had already ended; there was nothing left to stop.`,
                    },
                };
            },
        ],
    },
    post: {
        matcher: TASK_STOP_TOOLS,
        hooks: [
            async (input) => {
                if (input.hook_event_name !== "PostToolUse") {
                    return {};
                }
                const id = stopTarget(StopCallSchema.parse(input.tool_input));
                const job = id === undefined ? undefined : backgroundJobOf(jobs.conversations, jobs.conversationId, id);
                if (job !== undefined) {
                    // A job this turn's CLI can name was started in this turn, so no watch holds it yet to disarm.
                    await stopBackgroundJob(jobs.conversations, job, "agent");
                }
                return {};
            },
        ],
    },
});

// Where a Bash call's command files are written: a fenced turn's sandbox sees only its own temp dir, at the same path
// the daemon writes it; every other turn reads the daemon's.
const runRootFor = (isolation: TurnPlacement | undefined): string => isolation?.anchor?.sandbox?.tmp ?? tmpdir();

// A background job's seed, with its dir made where the turn can see it (runRootFor).
const jobSeedFor = (jobs: BackgroundJobSeed, isolation: TurnPlacement | undefined): BackgroundJobSeed => {
    const tmp = isolation?.anchor?.sandbox?.tmp;
    return tmp === undefined ? jobs : { ...jobs, tmp };
};

// What a pane's line runs through before the command: the hop into an anchored turn's namespace, since the shared tmux
// server forks panes in the daemon's. A fenced turn's panes need none: their tmux server runs inside its sandbox.
const paneHop = (isolation: TurnPlacement | undefined): string => {
    const anchor = isolation?.anchor;
    return anchor === undefined || anchor.sandbox !== undefined ? "" : nsenterPrefix(anchor.pid, anchor.cwd);
};

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
    // Only a turn that can file a job keeps its foreground calls to look at.
    const foreground = jobs === undefined ? undefined : new Map<string, ForegroundCall>();
    const stops = jobs === undefined ? undefined : taskStopHooks(jobs);
    return {
        ...(jobs === undefined || stops === undefined || foreground === undefined ? {} : { PostToolUse: [stops.post, overrunHooks(jobs, foreground)] }),
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
                                : startJob(jobSeedFor(jobs, isolation), { command, session, description: tool.description, toolUseId: input.tool_use_id });
                        // THE COMMAND TRAVELS BY FILE. `pkill -f` and `pgrep -f` match every process's whole command
                        // line, so a pattern that sat in any wrapper's argv (the CLI's shell, tmux-run, the pane's
                        // shell) killed the agent's own call. Written to files, it is in no argv at all: the CLI runs
                        // `tmux-run -f <dir>/line <session>`, the pane runs `bash <dir>/agent`, and the window name and
                        // the words the output filter reads sit beside them.
                        const dir = job?.dir ?? mkdtempSync(join(runRootFor(isolation), "intentic-run-"));
                        mkdirSync(dir, { recursive: true, mode: 0o700 });
                        const agentFile = join(dir, "agent");
                        writeFileSync(agentFile, `${PIPESTATUS_TRAP}${executed}\n`, { mode: 0o600 });
                        const run = `${POLITE_PREFIX}${NO_PROMPTS}${heavyEnv}bash ${shellQuote(agentFile)}`;
                        // Namespace hop and demotion sit inside the wrapper; the forked tree inherits both, tmux-run
                        // stays outside.
                        const inner = `${stamp}${paneHop(isolation)}${run}`;
                        writeFileSync(join(dir, "line"), `${inner}\n`, { mode: 0o600 });
                        writeFileSync(join(dir, "said"), command, { mode: 0o600 });
                        writeFileSync(join(dir, "name"), windowSlug(tool.description), { mode: 0o600 });
                        if (job === undefined) {
                            const { description, timeout } = CallFieldsSchema.parse(tool);
                            holdForeground({ dir, command, session, description, startedAt: Date.now(), toolUseId: input.tool_use_id, timeoutMs: timeout }, foreground);
                        }
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
            // After the Bash rewrite, which callers find first; the SDK matches each by its tool's name, not its place.
            ...(stops === undefined ? [] : [stops.pre]),
        ],
    };
};
