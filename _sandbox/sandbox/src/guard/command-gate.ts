import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { AdmissionRule, AgentEvent, CommandClass } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { commandRun } from "./actions.js";
import { classifyCommand, COMMAND_CLASS_LABELS } from "./command-classes.js";
import { guard, type GuardVerdict } from "./guard.js";
import type { TurnTaint } from "./turn-taint.js";

/* THE SECOND LAYER, under the admission floor. The floor (guard/actions.ts sessionStart) decides who may wake
 * the agent at all; this decides what a session that is ALREADY RUNNING may do — which is the only question
 * left once a turn is underway, and the one the permission card cannot answer on its own.
 *
 * It cannot, because the posture every interesting turn runs in is bypassPermissions: the container is the
 * isolation boundary, so `canUseTool` is never consulted, and an automation wake never had a person at a
 * composer to consult anyway. A PreToolUse hook is the one thing that still fires in that posture, and for
 * subagents too — so this gate holds exactly where the cards do not.
 *
 * A HOLD PARKS THE TURN. That is the whole difference from the outbound gate next door, which translates a hold
 * into a refusal pointing at the drafts outbox. A send has a held form — the draft IS the message, waiting —
 * and `git push --force` has none: there is the command or there is not the command. So a hold raises the same
 * permission card the SDK's own prompts use (agent-requests.ts mints it, the client renders it, /agent/reply
 * answers it) and the hook simply waits, which is what a hook returning a promise is allowed to do.
 *
 * UNLESS NOBODY IS THERE. An unattended turn gets the refusal, for the reason permissionGate gives at its own
 * unattended branch: a card raised where no one can answer hangs the turn until its timeout and reads as the
 * agent freezing, which is worse than a clear no. The policy does not change — only how it is delivered.
 *
 * Wired only when the owner has written a rule (turn-plan forwards none otherwise), so an unconfigured
 * workspace pays nothing. Read guard/command-classes.ts for what this does and does not catch: the classifier
 * is regex over shell text, so the gate is friction for well-behaved work and an ask for the owner, never the
 * boundary for a hostile one.
 */

export interface CommandGateOptions {
    readonly rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    // Nobody is at a composer: an automation wake, a loop iteration, a chore. Holds refuse instead of parking.
    readonly unattended: boolean;
    readonly push: (event: AgentEvent) => void;
    // The turn's own signal, so a parked card settles when the turn is stopped instead of holding it open.
    readonly signal: AbortSignal;
    /* This turn's outside-content bit (guard/turn-taint.ts), READ per command rather than snapshotted: the
     * page that taints a turn usually arrives mid-turn, several tool calls before the command that matters. */
    readonly taint: TurnTaint;
}

// How much of the command the card shows. Long enough for a heredoc's first lines to identify what this is,
// short enough that the card stays a card — the full text is in the transcript either way.
const SHOWN = 400;

const refuse = (reason: string): { hookSpecificOutput: Record<string, unknown> } => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

// The strictest verdict across the classes the command fell in, with the class that produced it — a deny beats
// a hold beats nothing, matching the admission floor's own most-restrictive-wins. Undefined ⇒ every class allows.
const decide = (
    classes: readonly CommandClass[],
    rules: CommandGateOptions["rules"],
    outsideSource: string | undefined,
): { commandClass: CommandClass; verdict: GuardVerdict } | undefined => {
    let held: { commandClass: CommandClass; verdict: GuardVerdict } | undefined;
    for (const commandClass of classes) {
        const verdict = guard(commandRun, { commandClass, rules, ...(outsideSource !== undefined ? { outsideSource } : {}) });
        if (verdict.effect === "deny") {
            return { commandClass, verdict };
        }
        if (verdict.effect === "hold" && held === undefined) {
            held = { commandClass, verdict };
        }
    }
    return held;
};

export const commandGateHooks = (options: CommandGateOptions): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    /* WHAT "ALWAYS" REMEMBERS — the classes the user has already said yes to, for the rest of THIS TURN. The
     * closure is built once per turn, and the button's label says so rather than promising a memory that is not
     * kept: the alternative is writing `allow` into the owner's own commandRules from a card, which is a
     * configuration change they did not come to the card to make. A turn that deletes twenty directories asks
     * once; the next turn asks again, which is the honest reading of a rule that still says hold. */
    const granted = new Set<CommandClass>();
    return {
        PreToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                            return {};
                        }
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string") {
                            return {};
                        }
                        const classes = classifyCommand(command).filter((commandClass) => !granted.has(commandClass));
                        const held = classes.length === 0 ? undefined : decide(classes, options.rules, options.taint.source());
                        if (held === undefined) {
                            return {};
                        }
                        if (held.verdict.effect === "deny") {
                            return refuse(held.verdict.reason);
                        }
                        if (options.unattended) {
                            return refuse(
                                `${held.verdict.reason}, and this turn is running unattended — there is nobody to approve it. ` +
                                    `Do not retry: carry on with what you can do without this command, and say plainly what you left undone.`,
                            );
                        }
                        const { id, wait } = createRequest("permission", {
                            kind: "permission",
                            requestId: "",
                            decision: "deny",
                            feedback: "The turn ended before you answered.",
                        });
                        options.push({
                            kind: "permission",
                            requestId: id,
                            toolName: "Bash",
                            title: `This command would ${COMMAND_CLASS_LABELS[held.commandClass]}`,
                            displayName: "Run command",
                            description: command.slice(0, SHOWN),
                            reason: held.verdict.reason,
                            alwaysLabel: `Allow every command that would ${COMMAND_CLASS_LABELS[held.commandClass]} this turn`,
                        });
                        const { reply, resolved } = await wait(options.signal);
                        options.push(resolved);
                        if (reply.decision === "deny") {
                            // A denial with feedback is a redirection and the turn takes it; a bare one is the user
                            // stopping this command, so say that rather than inviting a way around it.
                            return refuse(
                                reply.feedback?.trim() ||
                                    `The user declined this command. Do not run it, and do not look for another way to achieve the same thing — wait for them to say how to proceed.`,
                            );
                        }
                        if (reply.decision === "always") {
                            granted.add(held.commandClass);
                        }
                        return {};
                    },
                ],
            },
        ],
    };
};
