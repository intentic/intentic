import type { CommandRun, Rule } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { waitForMemoryHeadroom } from "../platform/resources/memory-admission.js";
import { prepushFailed } from "../push/notifications.js";
import { repoCheckRules, withRepoChecks } from "../rules/repo-checks.js";
import { type RuleCommandRun, runRuleCommand } from "../rules/rule-command.js";
import { ruleCwd } from "../rules/rule-cwd.js";
import { matching } from "../rules/rules.js";
import { CHECKS_SESSION } from "../terminal/terminal-session.js";

// Runs at push time, not post-land, since only the push has one artifact nothing else changes underneath before it
// leaves. Ephemeral: nothing persists or polls at rest, and a failure notifies the owner's devices since they aren't
// watching. Runs as a real terminal command on the main working tree, whose node_modules resolve to what actually
// ships.
//
// What stands here depends on WHICH repositories are going out: a rule the owner aimed at one, and the checks a
// repository declares for itself (rules/repo-checks.ts), both run only when that repository is in the push, and both
// run in its own directory. A workspace of one repository sees no difference; a workspace of four stops running the
// first one's suite against the other three.

// Output kept for the fix-turn prompt on a red run: the tail of the plain-text (color-stripped) output.
const PREPUSH_OUTPUT_BYTES = 24_000;

const IDLE: CommandRun = { status: "idle", command: "", output: "" };

export interface PrepushCheck {
    // Starts the check, idempotent while one is already going. Resolves once the run is visible to `state`, not when
    // the suite finishes, so the caller's first poll never sees a stale `idle`. `repos` is what is going out: empty
    // runs only what stands for every push.
    readonly run: (repos?: readonly string[]) => Promise<void>;
    // The run as it stands: the terminal's name while going, the verdict once it settles.
    readonly state: () => Promise<CommandRun>;
    // Stops the suite; shared by the dialog's Stop button and daemon shutdown, since the kill is the same.
    readonly cancel: () => void;
}

// Named explicitly rather than taking all of Services, so a test stands up only the seams it needs.
export type PrepushDeps = Pick<Services, "logger" | "sandboxSettings" | "workspace" | "terminalRun" | "pushSender" | "ruleFirings" | "activity">;

// A module singleton: routes and the shutdown hook must reach the same live run, and there is one working tree for them
// to share. Tests build their own via createPrepushCheck.
let instance: PrepushCheck | undefined;
export const prepushCheck = (services: PrepushDeps): PrepushCheck => (instance ??= createPrepushCheck(services));

export const createPrepushCheck = (services: PrepushDeps): PrepushCheck => {
    const { logger, terminalRun, workspace } = services;
    let current: CommandRun = IDLE;
    // The promise every concurrent caller joins instead of starting a second suite.
    let running: Promise<CommandRun> | undefined;
    // True from `run`'s entry until the command starts; covers the await window `running` can't guard.
    let starting = false;
    // Aborting SIGTERMs the wrapper, killing the tmux window; the runner tells cancel from timeout.
    let controller: AbortController | undefined;
    // What the last run was about, so `state` asks the same question `run` answered: with the push's repositories
    // forgotten, a poll would judge "is anything standing" against every repository instead of the ones going out.
    let asked: readonly string[] = [];

    // Runs every standing rule in order, stopping at the first failure: the push is already blocked, so there's no
    // reason to burn more of the suite. `current` republishes before each rule so a poll names the one actually
    // running.
    const execute = async (rules: readonly Rule[]): Promise<CommandRun> => {
        const startedAt = Date.now();
        const abort = new AbortController();
        controller = abort;
        // Only set where the tmux wrapper exists; otherwise the runner is an invisible shell with no tab to attach to.
        const session = terminalRun.visible ? CHECKS_SESSION : undefined;
        // Named only once the command is actually in the terminal: `session` on a running state is an instruction to
        // open it immediately, not a label, so naming it early would open an empty panel.
        let opened: string | undefined;
        const settle = (rule: Rule, command: string, run: RuleCommandRun): CommandRun => {
            const settled: CommandRun = {
                status: run.status,
                ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
                ...(run.timedOut !== undefined ? { timedOut: run.timedOut } : {}),
                command,
                startedAt,
                finishedAt: Date.now(),
                ...(opened !== undefined ? { session: opened } : {}),
                output: run.output,
            };
            current = settled;
            logger.info(
                { rule: rule.id, command, status: settled.status, exitCode: settled.exitCode, durationMs: Date.now() - startedAt },
                "prepush: check settled",
            );
            // Only the outcome that needs the user back travels to their devices; a pass needs nothing (the push just
            // goes) and a cancel needs nothing (they stopped it).
            if (settled.status === "failed" || settled.status === "error") {
                void services.pushSender.notifyIfAway(prepushFailed(settled));
            }
            return settled;
        };
        try {
            let last: CommandRun = IDLE;
            for (const rule of rules) {
                if (rule.action.kind !== "command") {
                    continue;
                }
                const { command, timeoutMs } = rule.action;
                opened = undefined;
                current = { status: "running", command, startedAt, output: "" };
                // The memory gate runs after `current` publishes, so the dialog shows the check as queued, not idle.
                // The wait is bounded; the suite then runs regardless.
                const headroom = await waitForMemoryHeadroom({ signal: abort.signal });
                if (headroom.waitedMs > 0) {
                    logger.info({ rule: rule.id, waitedMs: headroom.waitedMs, admitted: headroom.admitted }, "prepush: waited for memory headroom");
                }
                if (!headroom.admitted) {
                    logger.warn({ rule: rule.id, message: headroom.message }, "prepush: starting without memory headroom");
                }
                // A rule naming a repository runs there, so its command reads as it would in a terminal in that folder.
                const cwd = ruleCwd(workspace.root, rule);
                logger.info({ rule: rule.id, command, cwd, session }, "prepush: check started");
                // `window` names the tmux window, not the command, so a session with several runs reads as a list.
                const run = await runRuleCommand(services, {
                    command,
                    timeoutMs,
                    cwd,
                    session: CHECKS_SESSION,
                    window: "checks",
                    outputBytes: PREPUSH_OUTPUT_BYTES,
                    signal: abort.signal,
                    onStarted: () => {
                        opened = session;
                        // Republished, not mutated: this is the state that tells the dialog a terminal now exists to
                        // open.
                        current = { ...current, ...(session !== undefined ? { session } : {}) };
                    },
                });
                last = settle(rule, command, run);
                // Stamped on any run, not just failures, or a rule working perfectly would read as never used.
                void services.ruleFirings
                    .stamp(rule.id, Date.now())
                    .catch((error: unknown) => logger.warn({ err: error, rule: rule.id }, "prepush: firing stamp failed"));
                if (run.status !== "passed") {
                    // The one outcome worth a feed row: a pass says nothing, and a feed logging every green check gets
                    // ignored.
                    if (run.status !== "cancelled") {
                        void services.activity
                            .append({
                                direction: "system",
                                type: "rule.blocked_push",
                                content: `"${rule.label}" ran \`${command}\` before your push and it ${run.timedOut === true ? "timed out" : `exited ${run.exitCode ?? "abnormally"}`}, the push did not go.`,
                                outcome: "error",
                            })
                            .catch((error: unknown) => logger.warn({ err: error, rule: rule.id }, "prepush: activity append failed"));
                    }
                    return last;
                }
            }
            return last;
        } finally {
            controller = undefined;
        }
    };

    // Everything standing for this push, in the order it runs: the owner's rules and the repositories' own
    // declarations, narrowed to the repositories going out.
    const standingFor = async (repos: readonly string[]): Promise<Rule[]> => {
        const [settings, declared] = await Promise.all([services.sandboxSettings.get(), repoCheckRules(services)]);
        return matching(withRepoChecks(settings.rules, declared), "push.starting", { repos });
    };

    return {
        run: async (repos = []) => {
            // `starting`, not just `running`: set before the settings await, the only guard that holds across one.
            if (running !== undefined || starting) {
                return;
            }
            starting = true;
            try {
                asked = repos;
                const rules = await standingFor(repos);
                // No rule standing is the race where the last one was deleted between click and request.
                if (rules.length === 0) {
                    current = IDLE;
                    return;
                }
                // Not awaited: execute publishes `running` synchronously, before its first await.
                running = execute(rules).finally(() => {
                    running = undefined;
                });
                running.catch((error: unknown) => logger.warn({ err: error }, "prepush: check failed"));
            } finally {
                starting = false;
            }
        },
        state: async () => {
            // No rule means off, whatever the last run concluded; a stale result must not keep gating a push. Asked of
            // the same repositories the run was started for, so switching a repository's checks off mid-run reads as
            // off here too.
            if ((await standingFor(asked)).length === 0) {
                return IDLE;
            }
            return current;
        },
        cancel: () => {
            controller?.abort();
        },
    };
};
