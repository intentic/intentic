import { isAbsolute } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { Rule } from "@intentic/sandbox-contract";
import { createVerificationLedger, type ScriptsProbe, verifyEditsMessage } from "../agent/agent-verification.js";
import type { IsolationPlan } from "../agents/isolation.js";
import type { RuleCommandRun } from "./rule-command.js";
import { conditionHolds } from "./rules.js";

/* THE MOMENT A TURN TRIES TO END, every rule standing there, driven by one hook set.
 *
 * This is the only one of the three moments that can send work BACK. A push that fails is a push that does not
 * happen and finished work that is held is finished work sitting on a branch, but a turn that is told something
 * at its Stop keeps going and acts on it. That is worth the whole mechanism: it is the difference between
 * finding out afterwards and not shipping the mistake.
 *
 * CONDITIONS ARE READ HERE, NOT AT PLANNING TIME, and that is the reason this file exists rather than a filtered
 * list being handed to a dumb runner. A turn is planned before it runs, so nothing yet knows which files it will
 * touch, resolving `when: { paths: [...] }` up front would turn every path condition on this moment into
 * "never". The ledger below is what makes the late reading possible: by the Stop it knows what was edited.
 *
 * THE LEDGER IS KEPT WHENEVER ANY RULE STANDS HERE, not only for the `verify-edits` built-in, because the
 * conditions need it too. A workspace with no rules at this moment wires no hooks at all and pays nothing,
 * not even the bookkeeping.
 *
 * ONE BUDGET FOR THE WHOLE MOMENT. The cap below counts asks, not rules: three rules that each want a word are
 * one follow-up carrying three things, and a turn that could be sent back once per rule is a turn that can be
 * sent back forever. */

// At most this many follow-ups per turn, across every rule here. The model gets a second round only because
// the first is sometimes answered with a check that fails, one more to repair it is the point. A third is a
// loop.
const MAX_FOLLOW_UPS = 2;

// How much of a failed rule command's own words ride back to the model. Enough to act on, not enough to
// re-paste a suite.
const COMMAND_OUTPUT_BYTES = 4_000;

// Does this Bash result say the command failed? The tmux wrapper's footer carries the real exit code
// (`--- [exit 7, 2s] ...`), which is the authoritative answer whenever output filtering is on. Without a
// footer there is nothing to read here and the caller's event tells us instead: PostToolUse ⇒ ran,
// PostToolUseFailure ⇒ did not.
const footerExitCode = (response: unknown): number | undefined => {
    const text = typeof response === "string" ? response : typeof response === "object" && response !== null ? JSON.stringify(response) : "";
    const matches = [...text.matchAll(/---\s\[exit\s(\d+),/g)];
    const last = matches.at(-1)?.[1];
    return last === undefined ? undefined : Number(last);
};

const bashCommand = (input: unknown): string | undefined => {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
};

const editedPath = (input: unknown): string | undefined => {
    const path = (input as { file_path?: unknown }).file_path;
    return typeof path === "string" && path !== "" ? path : undefined;
};

// The agent names files absolutely; a rule is written the way the owner reads their own tree. A path OUTSIDE
// the turn's cwd is left alone rather than expressed as a pile of `../`, it is genuinely not a workspace path,
// and no workspace-shaped glob should match it.
const workspaceRelative = (path: string, cwd: string | undefined): string => {
    if (cwd === undefined || !isAbsolute(path)) {
        return path;
    }
    const rooted = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return path.startsWith(rooted) ? path.slice(rooted.length) : path;
};

// Run one rule's command at this moment. Injected rather than imported so the hook set stays testable without
// a tmux server, and because only turn-plan is standing where the daemon's services are.
export type TurnRuleCommand = (command: string, timeoutMs: number) => Promise<RuleCommandRun>;

export interface TurnEndingDeps {
    readonly isolation?: IsolationPlan | undefined;
    readonly runCommand?: TurnRuleCommand | undefined;
    /* The turn's own tree, so the paths a condition reads are spelled the way the owner spells them. The agent
     * names files absolutely; a rule says `docs/**`. Relativising here is what stops the SAME glob matching at
     * the landing moment and missing at this one, the one inconsistency that would make path conditions
     * untrustworthy everywhere. Absent ⇒ paths are left as the agent gave them. */
    readonly cwd?: string | undefined;
    // Told when a rule actually said something, so the settings list can show what has been earning its place.
    readonly onFired?: ((rule: Rule) => void) | undefined;
    readonly scripts?: ScriptsProbe | undefined;
}

// What one rule contributes to the follow-up, or nothing.
const contributionOf = async (rule: Rule, deps: TurnEndingDeps, ledger: ReturnType<typeof createVerificationLedger>): Promise<string | undefined> => {
    if (rule.action.kind === "builtin") {
        return verifyEditsMessage(ledger, deps.isolation, deps.scripts);
    }
    if (rule.action.kind === "instruct") {
        return rule.action.text;
    }
    if (rule.action.kind === "command") {
        // No runner ⇒ this turn has nowhere to run a command (an ACP or translator turn). Saying nothing is the
        // honest answer: inventing a follow-up about a command that never ran would be the check reporting a
        // result it does not have.
        if (deps.runCommand === undefined) {
            return undefined;
        }
        const { command, timeoutMs } = rule.action;
        const run = await deps.runCommand(command, timeoutMs);
        // A command that PASSED has nothing to say, the turn is free to end, which is what it was asked.
        if (run.status === "passed" || run.status === "cancelled") {
            return undefined;
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
    }
    return undefined;
};

/* The hooks. Edits and Bash results feed the ledger; Stop reads it, and the rules, once the turn tries to end.
 *
 * `stop_hook_active` is the SDK's own re-entry flag, true when this Stop is the one that follows a hook that
 * already continued the turn. The follow-up count is kept anyway (a turn can be stopped for other reasons in
 * between) and both are honoured, so neither alone can produce a loop. */
export const turnEndingHooks = (rules: readonly Rule[], deps: TurnEndingDeps = {}): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (rules.length === 0) {
        return {};
    }
    const ledger = createVerificationLedger();
    let followUps = 0;
    return {
        PostToolUse: [
            {
                matcher: "Edit|Write|NotebookEdit",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name === "PostToolUse") {
                            const path = editedPath(input.tool_input);
                            if (path !== undefined) {
                                ledger.noteEdit(path);
                            }
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
                            const exit = footerExitCode(input.tool_response);
                            const text = typeof input.tool_response === "string" ? input.tool_response : "";
                            ledger.noteCommand(command, exit === undefined || exit === 0, text);
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
                            ledger.noteCommand(command, false, input.error);
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
                        if (input.hook_event_name !== "Stop" || input.stop_hook_active || followUps >= MAX_FOLLOW_UPS) {
                            return {};
                        }
                        // What the turn touched, which is the only fact a condition can narrow on here. A turn
                        // that edited nothing still reaches rules with no path condition, "always say this
                        // before you finish" is a legitimate thing to want.
                        const facts = { paths: ledger.edited().map((path) => workspaceRelative(path, deps.cwd)) };
                        const parts: string[] = [];
                        for (const rule of rules) {
                            // The moment check is redundant with `standing` at the one call site and kept
                            // anyway: the failure it prevents is a rule firing at a moment it was not written
                            // for, which is silent, wrong, and exactly what a table like this must never do.
                            if (rule.moment !== "turn.ending" || !conditionHolds(rule.when, facts)) {
                                continue;
                            }
                            const contribution = await contributionOf(rule, deps, ledger);
                            if (contribution !== undefined && contribution !== "") {
                                parts.push(contribution);
                                deps.onFired?.(rule);
                            }
                        }
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
