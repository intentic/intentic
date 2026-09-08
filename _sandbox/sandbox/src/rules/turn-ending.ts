import { isAbsolute } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { GitRunner } from "@intentic/scaffold";
import type { Rule, RuleBuiltin } from "@intentic/sandbox-contract";
import { notFoundBinary } from "../agent/providers/agent-installs.js";
import { TEST_FILE } from "@intentic/constants/assertion-measure";
import { TEST_WRITING_NOTE } from "../agent/verification/agent-tests.js";
import { createRemovalLedger, type FileReader, readWorkspaceFile, type RemovalLedger, verifyRemovalsMessage } from "../agent/verification/agent-removals.js";
import {
    commandExitCode,
    createVerificationLedger,
    type ChecksProbe,
    type VerificationLedger,
    verifyEditsMessage,
} from "../agent/verification/agent-verification.js";
import { createViewLedger, isObservingCall, type ViewLedger, verifyUiEditsMessage } from "../agent/verification/agent-viewing.js";
import { inWorktree, type IsolationPlan } from "../agents/worktrees/isolation.js";
import type { RuleCommandRun } from "./rule-command.js";
import { conditionHolds, type RuleFacts } from "./rules.js";
import { EDIT_TOOLS, editedPath } from "./edit-tools.js";

// The only one of turn.ending, push.starting and agent.finished that can send work back: a Stop that says something
// keeps the turn going. Conditions are read here, not at planning time, since nothing knows what a turn touched until
// it runs; the ledger below makes that possible, wired and paid for only when a rule actually stands here.

// The loop's guard; `stop_hook_active` isn't it, that flag is true one Stop too early.
const MAX_FOLLOW_UPS = 2;

// Enough of a failed command's output to act on, not enough to re-paste a whole suite.
const COMMAND_OUTPUT_BYTES = 4_000;

const bashCommand = (input: unknown): string | undefined => {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
};

// A path outside the turn's cwd is left alone, not rewritten as `../` noise: it isn't a workspace path. Exported since
// other runtimes (agent/verify-nudge.ts) must relativise identically, or the same glob would mean two things.
export const workspaceRelative = (path: string, cwd: string | undefined): string => {
    if (cwd === undefined || !isAbsolute(path)) {
        return path;
    }
    const rooted = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return path.startsWith(rooted) ? path.slice(rooted.length) : path;
};

// Injected rather than imported, so the hook set is testable without a tmux server and usable where turn-plan stands,
// not the daemon's services.
export type TurnRuleCommand = (command: string, timeoutMs: number) => Promise<RuleCommandRun>;

export interface TurnEndingDeps {
    readonly isolation?: IsolationPlan | undefined;
    readonly runCommand?: TurnRuleCommand | undefined;
    // Relativises paths to the turn's tree, so a glob matches equally here and at landing; absent leaves it as-is.
    readonly cwd?: string | undefined;
    // Told when a rule actually said something, so the settings list can show what has been earning its place.
    readonly onFired?: ((rule: Rule) => void) | undefined;
    readonly checks?: ChecksProbe | undefined;
    // Injected together: supplying one without the other is testing half against a real workspace.
    readonly read?: FileReader | undefined;
    readonly git?: GitRunner | undefined;
    readonly now?: number | undefined;
    // Asked only after a command fails: agent-deps.ts's premise that no install runs during a turn isn't true.
    readonly installing?: (() => Promise<readonly string[]>) | undefined;
    // Misses what the edit ledger can't hear: a shell rewrite (sed -i, a heredoc). Absent uses the ledger alone.
    readonly changedPaths?: (() => Promise<readonly string[]>) | undefined;
    // Every command run, whatever it said; the land step (agent/turn-checks.ts) reads the last one to decide.
    readonly onCheckRun?: ((rule: Rule, run: RuleCommandRun) => void) | undefined;
    // The verify-tests built-in's whole answer, bound by the planner; absent means it has nothing to say.
    readonly tests?: (() => Promise<string | undefined>) | undefined;
}

// `removal` exists only when a rule standing here reads it: snapshotting file contents before every edit is the one
// expensive piece worth skipping.
interface Ledgers {
    readonly verification: VerificationLedger;
    readonly removal: RemovalLedger | undefined;
    // Unconditional like the proof ledger: cheap counters over hooks already firing; only `removal` reads files.
    readonly view: ViewLedger;
}

// Whether a failing command measured the diff at all: `error` (rule-command.ts) never ran, and a run that failed only
// because node_modules was mid-rewrite measured the tree, not the diff. Undefined means the failure is a real verdict.
type Unmeasured =
    | { readonly why: "error" }
    | { readonly why: "installing"; readonly projects: readonly string[] }
    | { readonly why: "missing-tool"; readonly binary: string };

const measuredNothing = async (run: RuleCommandRun, deps: TurnEndingDeps): Promise<Unmeasured | undefined> => {
    if (run.status === "error") {
        return { why: "error" };
    }
    // An unanswerable question defaults to no install, so the verdict stands rather than being excused by a shrug.
    const installing = deps.installing === undefined ? [] : await deps.installing().catch(() => []);
    if (installing.length > 0) {
        return { why: "installing", projects: installing };
    }
    // Catches what `installing` above misses: an install that finished between the check running and this probe.
    const binary = notFoundBinary(run.output);
    return binary === undefined ? undefined : { why: "missing-tool", binary };
};

const unmeasuredReason = (run: RuleCommandRun, unmeasured: Unmeasured): string => {
    if (unmeasured.why === "installing") {
        return `a dependency install is running (${unmeasured.projects.join(", ")}), so node_modules is being rewritten under it.`;
    }
    if (unmeasured.why === "missing-tool") {
        return `\`${unmeasured.binary}\` was not on PATH when it ran, and still is not on the re-run, so the check never started. That is a fact about the install, not about the diff.`;
    }
    return run.output.slice(-COMMAND_OUTPUT_BYTES);
};

// Said instead of a verdict, worded so nobody hunts the diff for a fault; still counts as a round, since the tree
// usually settles by the next one.
const nothingMeasured = (label: string, command: string, run: RuleCommandRun, unmeasured: Unmeasured): string =>
    [
        `Before finishing, "${label}" could not measure anything:`,
        `\`${command}\``,
        unmeasuredReason(run, unmeasured),
        `That is not a verdict on this turn's work and nothing here needs repairing. Re-run it once the tree settles, or say plainly that the check could not run.`,
    ]
        .filter((line) => line !== "")
        .join("\n");

// A total table over the builtin name: adding one to the contract is a compile error here until answered.
const BUILTINS: Record<RuleBuiltin, (deps: TurnEndingDeps, ledgers: Ledgers) => Promise<string | undefined>> = {
    "verify-edits": (deps, ledgers) => verifyEditsMessage(ledgers.verification, deps.isolation, deps.checks),
    "verify-removals": async (deps, ledgers) =>
        ledgers.removal === undefined
            ? undefined
            : verifyRemovalsMessage(ledgers.removal, {
                  cwd: deps.cwd,
                  isolation: deps.isolation,
                  read: deps.read,
                  git: deps.git,
                  now: deps.now,
              }),
    "verify-ui-edits": async (_deps, ledgers) => verifyUiEditsMessage(ledgers.view),
    "verify-tests": async (deps) => (deps.tests === undefined ? undefined : deps.tests()),
};

// Re-runs a failing check only when its output names a missing binary, the sign of a mid-install tree. Not a retry
// loop: two runs answer it, and a tool still missing on the second is a workspace problem to report, not hide.
const settledRun = async (runCommand: TurnRuleCommand, command: string, timeoutMs: number): Promise<RuleCommandRun> => {
    const first = await runCommand(command, timeoutMs);
    if (first.status === "passed" || first.status === "cancelled" || notFoundBinary(first.output) === undefined) {
        return first;
    }
    return runCommand(command, timeoutMs);
};

// A command rule's contribution: what its run said, or what stood in the way of a run saying anything.
const commandContribution = async (
    rule: Rule,
    action: { readonly command: string; readonly timeoutMs: number },
    runCommand: TurnRuleCommand,
    deps: TurnEndingDeps,
): Promise<string | undefined> => {
    const { command, timeoutMs } = action;
    const run = await settledRun(runCommand, command, timeoutMs);
    deps.onCheckRun?.(rule, run);
    // Cancelled counts as nothing to say too, same as a pass: the turn is free to end either way.
    if (run.status === "passed" || run.status === "cancelled") {
        return undefined;
    }
    const unmeasured = await measuredNothing(run, deps);
    if (unmeasured !== undefined) {
        return nothingMeasured(rule.label, command, run, unmeasured);
    }
    const why = run.timedOut === true ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited ${run.exitCode ?? "abnormally"}`;
    return [
        `Before finishing, "${rule.label}" ran this and it ${why}:`,
        `\`${command}\``,
        run.output.slice(-COMMAND_OUTPUT_BYTES),
        `Repair that before finishing, or say plainly why it cannot be repaired here.`,
    ]
        .filter((line) => line !== "")
        .join("\n");
};

// What one rule contributes to the follow-up, or nothing.
const contributionOf = async (rule: Rule, deps: TurnEndingDeps, ledgers: Ledgers): Promise<string | undefined> => {
    if (rule.action.kind === "builtin") {
        return BUILTINS[rule.action.name](deps, ledgers);
    }
    if (rule.action.kind === "instruct") {
        return rule.action.text;
    }
    if (rule.action.kind === "command") {
        // No runner: this turn (ACP, a translator) has nowhere to run a command; nothing beats inventing a result.
        return deps.runCommand === undefined ? undefined : commandContribution(rule, rule.action, deps.runCommand, deps);
    }
    return undefined;
};

// The hooks: edits and Bash results feed the ledger, Stop reads it against the rules once the turn tries to end.
// `stop_hook_active` is deliberately not read, since it's true on the very Stop that must re-measure a repair.
export const turnEndingHooks = (rules: readonly Rule[], deps: TurnEndingDeps = {}): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (rules.length === 0) {
        return {};
    }
    // Kept only when a rule reads it: it reads every file before its first edit, not free enough for everyone.
    const wantsRemovals = rules.some(
        (rule) => rule.enabled && rule.moment === "turn.ending" && rule.action.kind === "builtin" && rule.action.name === "verify-removals",
    );
    // The two sentences about writing tests are said only where the rule that reads the result stands, and once.
    const wantsTests = rules.some(
        (rule) => rule.enabled && rule.moment === "turn.ending" && rule.action.kind === "builtin" && rule.action.name === "verify-tests",
    );
    const ledgers: Ledgers = {
        verification: createVerificationLedger(),
        removal: wantsRemovals ? createRemovalLedger() : undefined,
        view: createViewLedger(),
    };
    const { removal } = ledgers;
    const read = deps.read ?? readWorkspaceFile;
    let followUps = 0;
    let testNoted = false;
    // What every rule standing here has to say about this occasion, in the owner's order, telling `onFired`
    // for each that spoke.
    const contributionsAt = async (facts: RuleFacts): Promise<string[]> => {
        const parts: string[] = [];
        for (const rule of rules) {
            // Redundant with `standing` at its call site, kept since a wrong-moment rule firing would be silent and
            // wrong.
            if (rule.moment !== "turn.ending" || !conditionHolds(rule.when, facts)) {
                continue;
            }
            const contribution = await contributionOf(rule, deps, ledgers);
            if (contribution !== undefined && contribution !== "") {
                parts.push(contribution);
                deps.onFired?.(rule);
            }
        }
        return parts;
    };
    return {
        ...(removal === undefined
            ? {}
            : {
                  // Read before the edit; the edit tools carry no old content after, and only the first read per path
                  // is kept.
                  PreToolUse: [
                      {
                          matcher: EDIT_TOOLS,
                          hooks: [
                              async (input) => {
                                  if (input.hook_event_name === "PreToolUse") {
                                      const path = editedPath(input.tool_input);
                                      if (path !== undefined) {
                                          removal.notePrior(path, await read(inWorktree(path, deps.isolation)));
                                      }
                                  }
                                  return {};
                              },
                          ],
                      },
                  ],
              }),
        PostToolUse: [
            {
                matcher: EDIT_TOOLS,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name === "PostToolUse") {
                            const path = editedPath(input.tool_input);
                            if (path !== undefined) {
                                ledgers.verification.noteEdit(path);
                                // The view ledger filters at its own door: one edit feeds two records, each with its
                                // own idea of what matters.
                                ledgers.view.noteEdit(path);
                                // Sent once, on the first test file edited: the model needs it once, and the Stop reads
                                // the result regardless.
                                if (wantsTests && !testNoted && TEST_FILE.test(path)) {
                                    testNoted = true;
                                    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: TEST_WRITING_NOTE } };
                                }
                            }
                        }
                        return {};
                    },
                ],
            },
            {
                // Matches every browser MCP call; whether one counts as looking is the ledger's question, not the
                // matcher's.
                matcher: "mcp__.+__browser_.+",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name === "PostToolUse" && isObservingCall(input.tool_name)) {
                            ledgers.view.noteLook(input.tool_name);
                        }
                        return {};
                    },
                ],
            },
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const command = bashCommand(input.tool_input);
                        if (command !== undefined) {
                            const exit = commandExitCode(input.tool_response);
                            const text = typeof input.tool_response === "string" ? input.tool_response : "";
                            ledgers.verification.noteCommand(command, exit === undefined || exit === 0, text);
                        }
                        return {};
                    },
                ],
            },
        ],
        PostToolUseFailure: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUseFailure") {
                            return {};
                        }
                        const command = bashCommand(input.tool_input);
                        if (command !== undefined) {
                            ledgers.verification.noteCommand(command, false, input.error);
                        }
                        return {};
                    },
                ],
            },
        ],
        Stop: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "Stop" || followUps >= MAX_FOLLOW_UPS) {
                            return {};
                        }
                        // Edited paths plus what the tree shows changed; a turn with nothing edited still fires
                        // unconditioned rules.
                        const edited = ledgers.verification.edited().map((path) => workspaceRelative(path, deps.cwd));
                        const changed = deps.changedPaths === undefined ? [] : await deps.changedPaths().catch(() => []);
                        const facts = { paths: [...new Set([...edited, ...changed])] };
                        const parts = await contributionsAt(facts);
                        if (parts.length === 0) {
                            return {};
                        }
                        followUps += 1;
                        return {
                            hookSpecificOutput: { hookEventName: "Stop", additionalContext: parts.join("\n\n") },
                        };
                    },
                ],
            },
        ],
    };
};
