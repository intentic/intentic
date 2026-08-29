import { isAbsolute } from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { GitRunner } from "@intentic/scaffold";
import type { Rule, RuleBuiltin } from "@intentic/sandbox-contract";
import {
    createRemovalLedger,
    type FileReader,
    readWorkspaceFile,
    type RemovalLedger,
    verifyRemovalsMessage,
} from "../agent/agent-removals.js";
import { commandExitCode, createVerificationLedger, type ScriptsProbe, type VerificationLedger, verifyEditsMessage } from "../agent/agent-verification.js";
import { inWorktree, type IsolationPlan } from "../agents/isolation.js";
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

const bashCommand = (input: unknown): string | undefined => {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" && command.trim() !== "" ? command : undefined;
};

/* Every tool that MUTATES a file, as one matcher.
 *
 * The hashline pair belongs here because turning `hashlineEdits` on DISABLES the native Edit and Write
 * (hashline/hashline-tools.ts): a matcher naming only those two goes quiet in exactly the configuration a user
 * chooses for heavy editing, so both ledgers below would have recorded nothing and said so confidently. */
const EDIT_TOOLS = "Edit|Write|NotebookEdit|mcp__hashline__edit|mcp__hashline__write";

// The native tools name it `file_path`, the hashline ones `path`. One reader over both, because which spelling
// arrives is a setting the owner flipped and not a fact about the edit.
const editedPath = (input: unknown): string | undefined => {
    const named = input as { file_path?: unknown; path?: unknown };
    const path = typeof named.file_path === "string" ? named.file_path : named.path;
    return typeof path === "string" && path !== "" ? path : undefined;
};

/* The agent names files absolutely; a rule is written the way the owner reads their own tree. A path OUTSIDE
 * the turn's cwd is left alone rather than expressed as a pile of `../`, it is genuinely not a workspace path,
 * and no workspace-shaped glob should match it.
 *
 * Exported for the runtimes that get their follow-up as a fresh turn rather than through this hook set
 * (agent/verify-nudge.ts). Both readers have to relativise identically or the same glob means two things
 * depending on which provider ran the turn, which is the one inconsistency that would make path conditions
 * untrustworthy everywhere. */
export const workspaceRelative = (path: string, cwd: string | undefined): string => {
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
    // How `verify-removals` reads a file and asks git about a line. Injected together because a test that
    // supplies one and not the other is a test half against a real workspace.
    readonly read?: FileReader | undefined;
    readonly git?: GitRunner | undefined;
    readonly now?: number | undefined;
}

// The two records this moment keeps. `removal` exists only when a rule standing here reads it: it snapshots
// file contents before every edit, which is the one piece of bookkeeping expensive enough to be worth skipping.
interface Ledgers {
    readonly verification: VerificationLedger;
    readonly removal: RemovalLedger | undefined;
}

/* WHAT EACH BUILT-IN ASKS OF THE TURN, as a total table over the name rather than a chain of ifs: a built-in
 * added to the contract is a compile error here until it is answered, which is the only thing that keeps a rule
 * from saving cleanly in the settings screen and then quietly doing nothing. */
const BUILTINS: Record<RuleBuiltin, (deps: TurnEndingDeps, ledgers: Ledgers) => Promise<string | undefined>> = {
    "verify-edits": (deps, ledgers) => verifyEditsMessage(ledgers.verification, deps.isolation, deps.scripts),
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
    /* The deletion record is kept ONLY when a rule standing here reads it, and it is the one ledger worth
     * asking that question about: it reads every file the turn is about to edit, before each first edit. That
     * is cheap next to the edit itself and it is not free, so a workspace that has not asked for the check does
     * not pay for the snapshot. The proof ledger stays unconditional because the CONDITIONS need it. */
    const wantsRemovals = rules.some((rule) => rule.enabled && rule.moment === "turn.ending" && rule.action.kind === "builtin" && rule.action.name === "verify-removals");
    const ledgers: Ledgers = { verification: createVerificationLedger(), removal: wantsRemovals ? createRemovalLedger() : undefined };
    const { removal } = ledgers;
    const read = deps.read ?? readWorkspaceFile;
    let followUps = 0;
    return {
        ...(removal === undefined
            ? {}
            : {
                  /* BEFORE the edit, because after it the bytes are gone and no hook input carries them: `Edit`
                   * has `old_string`, `Write` and the hashline tools have nothing at all. Reading the file here
                   * is the only way to know what a turn removed, and the ledger keeps just the first read per
                   * path, so a file edited five times is one snapshot. */
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
                        if (input.hook_event_name !== "Stop" || input.stop_hook_active || followUps >= MAX_FOLLOW_UPS) {
                            return {};
                        }
                        // What the turn touched, which is the only fact a condition can narrow on here. A turn
                        // that edited nothing still reaches rules with no path condition, "always say this
                        // before you finish" is a legitimate thing to want.
                        const facts = { paths: ledgers.verification.edited().map((path) => workspaceRelative(path, deps.cwd)) };
                        const parts: string[] = [];
                        for (const rule of rules) {
                            // The moment check is redundant with `standing` at the one call site and kept
                            // anyway: the failure it prevents is a rule firing at a moment it was not written
                            // for, which is silent, wrong, and exactly what a table like this must never do.
                            if (rule.moment !== "turn.ending" || !conditionHolds(rule.when, facts)) {
                                continue;
                            }
                            const contribution = await contributionOf(rule, deps, ledgers);
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
