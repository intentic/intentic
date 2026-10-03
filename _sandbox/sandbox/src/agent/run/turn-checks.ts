import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { Rule } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { EditCommandRun } from "../../rules/file-edited.js";
import { conditionHolds } from "../../rules/rules.js";

/* WHAT A REPOSITORY'S OWN `turn` CHECKS FOUND IN A TURN'S CHANGE, said back to it once at Stop. */

// Nothing here holds the turn, its land, a commit or a push: the model reads what was found once, and fixes it or says
// why not. The Claude Code loop alone, since the SDK's Stop hook is the one place a runtime lets the daemon answer a
// model that is about to stop; a Codex, Cursor or ACP turn ends without these checks, as every turn did while the
// moment ran nothing.

// The longest a Stop waits on one check, whatever the check allows itself: past this the turn has sat at its last word
// long enough, and the check is reported as one that could not run.
export const TURN_CHECK_CEILING_MS = 180_000;
// How much of what the checks printed rides back, across all of them: room for a list of findings, not for a log.
export const TURN_CHECK_OUTPUT_BYTES = 6_000;
// What the SDK allows the hook beyond the checks' own ceilings, for reading what the turn changed.
const HOOK_SLACK_SECONDS = 60;

// What the turn changed, as a rule's condition reads it: workspace-relative paths, and the repositories they fall in.
export interface TurnChange {
    readonly paths: readonly string[];
    readonly repos: readonly string[];
}

// One rule's command, run in the repository the rule names, in the turn's own tree.
export type TurnCheckRunner = (command: string, timeoutMs: number, repo: string | undefined) => Promise<EditCommandRun>;

/** The repositories' `turn` checks, bound to one isolated turn (run/harness/harness-hooks.ts). */
export interface TurnChecks {
    // The `turn.ending` rules a repository declared, never one the owner wrote (rules/repo-checks.ts's declaredChecks).
    readonly rules: readonly Rule[];
    // What the conversation's work changed against the commit its checkout stands on, committed and uncommitted alike.
    readonly change: () => Promise<TurnChange>;
    readonly run: TurnCheckRunner;
    // Stamps a rule that reported something, for the date its row on the settings list shows.
    readonly onFired: (rule: Rule) => void;
    // Where a fault in reading the change or running a check goes: it costs the turn this one line and nothing else.
    readonly logger: Pick<Logger, "warn">;
}

// What this module adds to the loop's hook set (agent.ts mergeHooks): one Stop matcher, or nothing.
export interface TurnCheckHooks {
    readonly Stop?: HookCallbackMatcher[];
}

// A check that did not pass, and what it printed.
export interface TurnCheckReport {
    readonly rule: Rule;
    readonly run: EditCommandRun;
}

/** Every matching check that did not pass on the turn's change, in the rules' order, each stamped as fired; none when the
 *  turn changed nothing. One at a time, since each reads the whole tree. */
export const turnCheckReports = async (checks: TurnChecks): Promise<TurnCheckReport[]> => {
    const change = await checks.change();
    if (change.paths.length === 0) {
        return [];
    }
    const reports: TurnCheckReport[] = [];
    for (const rule of checks.rules) {
        if (rule.action.kind !== "command" || !conditionHolds(rule.when, change)) {
            continue;
        }
        const run = await checks.run(rule.action.command, Math.min(rule.action.timeoutMs, TURN_CHECK_CEILING_MS), rule.when?.repo);
        if (run.status !== "passed") {
            checks.onFired(rule);
            reports.push({ rule, run });
        }
    }
    return reports;
};

// The end of what a check printed, within `bytes`; the end is where a check sums up.
const tailOf = (output: string, bytes: number): string => {
    const trimmed = output.trim();
    return trimmed.length <= bytes ? trimmed : `…${trimmed.slice(-bytes)}`;
};

const named = (rule: Rule): string => `"${rule.label}"${rule.when?.repo === undefined || rule.when.repo === "root" ? "" : ` in ${rule.when.repo}`}`;

/** The one thing said back at Stop: each check that found something, by its label, with what it printed, then each that
 *  could not run, worded as a fact about the command rather than a verdict on the change, since nobody should be sent to
 *  repair what nothing measured. */
export const turnChecksNote = (reports: readonly TurnCheckReport[]): string => {
    const share = Math.floor(TURN_CHECK_OUTPUT_BYTES / Math.max(reports.length, 1));
    const found = reports.filter(({ run }) => run.status === "failed");
    const unrun = reports.filter(({ run }) => run.status !== "failed");
    const command = (rule: Rule): string => (rule.action.kind === "command" ? rule.action.command : "");
    return [
        found.length > 0
            ? "As this turn ends, the checks the repositories you changed declare for that moment ran once on your change, and attribute these findings to it:"
            : "As this turn ends, the checks the repositories you changed declare for that moment were to run once on your change, and could not:",
        ...found.map(({ rule, run }) => `${named(rule)}:\n${tailOf(run.output, share)}`),
        ...unrun.map(({ rule, run }) => `${named(rule)} could not run (\`${command(rule)}\`): ${tailOf(run.output, share)}. That is not a verdict on the change.`),
        found.length > 0
            ? "Fix the ones that are yours now, or say plainly why one is not. Nothing is refused, and this is said once."
            : "Nothing is refused, and this is said once.",
    ].join("\n\n");
};

/** The repositories' `turn` checks as a Stop matcher (agent.ts mergeHooks), beside the checklist note (checklist-close.ts).
 *  Wires nothing for a turn in the shared tree, whose working tree carries everyone's uncommitted work, or for one no
 *  adopted repository declares a `turn` check for. */
export const turnCheckHooks = (checks: TurnChecks | undefined, isolated: boolean): TurnCheckHooks => {
    if (checks === undefined || !isolated || checks.rules.length === 0) {
        return {};
    }
    // Once per turn, whatever was found: a second Stop is the model's answer to the first, and asking again would turn
    // a report into a gate. A closure per turn, like every other memory in this hook set.
    let ran = false;
    return {
        Stop: [
            {
                // Sized to the checks' own ceilings, so a slow check is reported as one that could not run before the SDK
                // abandons the hook that waits on it.
                timeout: Math.ceil((checks.rules.length * TURN_CHECK_CEILING_MS) / 1000) + HOOK_SLACK_SECONDS,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "Stop" || ran) {
                            return {};
                        }
                        ran = true;
                        try {
                            const reports = await turnCheckReports(checks);
                            return reports.length === 0 ? {} : { hookSpecificOutput: { hookEventName: "Stop", additionalContext: turnChecksNote(reports) } };
                        } catch (error) {
                            // Never a failed Stop: a check that cannot be run is no reason to keep the turn from ending.
                            checks.logger.warn({ err: error }, "turn checks: could not run the repositories' turn checks, so the turn ends without them");
                            return {};
                        }
                    },
                ],
            },
        ],
    };
};
