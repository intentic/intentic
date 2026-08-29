import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { type AdmissionRule, type AgentEvent, classifyCommand, COMMAND_CLASS_LABELS, type CommandClass } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { commandRun } from "./actions.js";
import { guard, type GuardVerdict } from "./guard.js";
import type { TurnTaint } from "./turn-taint.js";

/* THE SECOND LAYER, under the admission floor. The floor (guard/actions.ts sessionStart) decides who may wake
 * the agent at all; this decides what a session that is ALREADY RUNNING may do, which is the only question
 * left once a turn is underway, and the one the permission card cannot answer on its own.
 *
 * It cannot, because the posture every interesting turn runs in is bypassPermissions: the container is the
 * isolation boundary, so `canUseTool` is never consulted, and an automation wake never had a person at a
 * composer to consult anyway.
 *
 * TWO LAYERS IN THIS FILE, and the split is the point.
 *
 * `createCommandGate` is the DECISION, and it knows nothing about how a runtime asks. Hand it a program about
 * to run and it answers allow-or-refuse: classify, consult the rulebook, apply the taint floor, raise a card
 * and park on it, or refuse where nobody can answer. Every runtime gets the same verdict from the same decide
 * fn for the same command, which is what makes a rule the owner wrote a rule rather than a Claude Code rule.
 *
 * `commandGateHooks` is one TRANSPORT over that decision: a PreToolUse hook, which fires even under
 * bypassPermissions and for subagents too, so it holds exactly where the cards never do. The other transports
 * live with the runtimes that speak them, because the vendor's protocol is theirs and not this module's
 * business: Codex answers `item/commandExecution/requestApproval` (codex/codex-agent.ts, codexCommandApproval),
 * and an ACP agent answers `session/request_permission` (acp/acp-permissions.ts).
 * They differ in ONE stated way, and the capability record carries it (`rulebook: "approval"`): the vendor
 * decides which calls it asks about, so a class it never raises is a class no rule can reach. What it does
 * raise is judged here.
 *
 * A HOLD PARKS THE TURN. That is the whole difference from the outbound gate next door, which translates a hold
 * into a refusal pointing at the drafts outbox. A send has a held form, the draft IS the message, waiting,
 * and `git push --force` has none: there is the command or there is not the command. So a hold raises the same
 * permission card the SDK's own prompts use (agent-requests.ts mints it, the client renders it, /agent/reply
 * answers it) and the caller simply waits, which every transport here is allowed to do.
 *
 * UNLESS NOBODY IS THERE. An unattended turn gets the refusal, for the reason permissionGate gives at its own
 * unattended branch: a card raised where no one can answer hangs the turn until its timeout and reads as the
 * agent freezing, which is worse than a clear no. The policy does not change, only how it is delivered.
 *
 * Read sandbox-contract's command-classes.ts for what this does and does not catch: the classifier is regex over shell text,
 * so the gate is friction for well-behaved work and an ask for the owner, never the boundary for a hostile one.
 */

export interface CommandGateOptions {
    readonly rules: Partial<Readonly<Record<CommandClass, AdmissionRule>>>;
    // Nobody is at a composer: an automation wake, a loop iteration, a chore. Holds refuse instead of parking.
    readonly unattended: boolean;
    /* Whether THIS TRANSPORT can hold a call open while a person answers. Default true.
     *
     * False for a runtime whose vendor puts a clock on the wait: OpenCode's turn has an inactivity watchdog that
     * counts a paused approval as a stalled turn and aborts it, so a card parked there would break the turn
     * rather than gate it. Such a transport gets the DENY half of the rulebook (and the unattended half), and a
     * hold arrives as a refusal that says which rule asked and that this runtime could not ask.
     *
     * Distinct from `unattended` on purpose, though both turn a hold into a refusal: one is a fact about whether
     * anybody is watching, the other about whether this runtime could wait if they were, and telling a user
     * "there is nobody to approve it" on a turn they are sitting in front of would be a lie. */
    readonly canPark?: boolean;
    // The turn's own signal, so a parked card settles when the turn is stopped instead of holding it open.
    readonly signal: AbortSignal;
    /* This turn's outside-content bit (guard/turn-taint.ts), READ per command rather than snapshotted: the
     * page that taints a turn usually arrives mid-turn, several tool calls before the command that matters. */
    readonly taint: TurnTaint;
}

// How much of the command the card shows. Long enough for a heredoc's first lines to identify what this is,
// short enough that the card stays a card, the full text is in the transcript either way.
const SHOWN = 400;

/* WHAT IS ABOUT TO RUN, in the words the card will use. Carried by the caller rather than derived here, because
 * only the caller knows whether its runtime is about to run a shell line, a script, or a vendor tool call whose
 * own name the user has seen elsewhere in the transcript. */
export interface GateSubject {
    // Files the card under a tool the client already renders, and matches the SDK hook on the Claude path.
    readonly toolName: string;
    // The card's chip: "Run command", "Run code".
    readonly displayName: string;
    // How the title reads: "This command would delete files recursively".
    readonly noun: string;
}

const BASH_SUBJECT: GateSubject = { toolName: "Bash", displayName: "Run command", noun: "command" };
const JS_SUBJECT: GateSubject = { toolName: JS_TOOL_NAME, displayName: "Run code", noun: "script" };

// A vendor runtime's own command tool, whatever it calls it. One subject for all of them: the card names the
// consequence, and which vendor tool carried it is in the transcript beside it either way.
export const vendorSubject = (toolName: string): GateSubject => ({ toolName, displayName: "Run command", noun: "command" });

// Allow ⇒ run it. Refuse ⇒ do not, and hand `reason` back to the model as the refusal, in the vendor's own
// vocabulary at the call site.
export type GateOutcome = { readonly allow: true } | { readonly allow: false; readonly reason: string };

const ALLOWED: GateOutcome = { allow: true };

export interface CommandGate {
    /* Whether ANYTHING here can refuse this turn. True on every turn now: the owner's rules, the taint floor,
     * and the standing floor under the classes nothing undoes (guard/actions.ts commandRun), the last of which
     * applies to a workspace that has never opened the settings.
     *
     * Read by the runtimes whose gate is the VENDOR'S approval channel, because turning that channel on is a
     * decision at turn start: Codex asks nothing under `approvalPolicy: "never"` and OpenCode nothing under an
     * allow-all config, and flipping either costs an approval round-trip per call. guard/turn-gate.ts's
     * turnIsGated is the same answer read before a turn exists, and states what the round-trip buys.
     *
     * Kept as a field rather than folded away, because it is the seam a runtime that CANNOT ask would read to
     * say so, and because the "always" grants below are what make the per-call cost bearable within a turn. */
    readonly enforcing: boolean;
    /* The whole decision for one program about to run, AS A GENERATOR: the frames it yields are the permission
     * card and its resolution, and the return value is the verdict. Never throws, a guard that cannot answer
     * denies (guard/guard.ts).
     *
     * A generator rather than `Promise<GateOutcome>` plus an injected `push`, because the two kinds of caller
     * here want opposite things and only this shape serves both. A vendor runtime whose approval arrives as an
     * event inside its own `for await` loop is ALREADY in a generator: it writes
     * `const outcome = yield* gate.consult(...)` and the card goes out in order, with nothing buffered and no
     * queue to wake. A callback-shaped caller (the Claude Code hook, an ACP permission handler) has no generator
     * to be in, and drains this with `consultWith` below. The earlier shape, a promise that called `push` and
     * then awaited, deadlocks the first kind: the generator is parked inside the await and cannot yield the very
     * card the await is waiting on. */
    readonly consult: (program: string, subject: GateSubject) => AsyncGenerator<AgentEvent, GateOutcome>;
}

/* Drive a consult from a caller that emits by CALLBACK rather than by yielding. Every frame goes to `push` in
 * the order the gate produced it, and the verdict comes back. */
export const consultWith = async (
    gate: CommandGate,
    program: string,
    subject: GateSubject,
    push: (event: AgentEvent) => void,
): Promise<GateOutcome> => {
    const consulting = gate.consult(program, subject);
    let step = await consulting.next();
    while (step.done !== true) {
        push(step.value);
        step = await consulting.next();
    }
    return step.value;
};

// The strictest verdict across the classes the command fell in, with the class that produced it, a deny beats
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

export const createCommandGate = (options: CommandGateOptions): CommandGate => {
    /* WHAT "ALWAYS" REMEMBERS, the classes the user has already said yes to, for the rest of THIS TURN. The
     * closure is built once per turn, and the button's label says so rather than promising a memory that is not
     * kept: the alternative is writing `allow` into the owner's own commandRules from a card, which is a
     * configuration change they did not come to the card to make. A turn that deletes twenty directories asks
     * once; the next turn asks again, which is the honest reading of a rule that still says hold.
     *
     * SHARED ACROSS EVERY SUBJECT on purpose: the grant is about a CLASS of consequence ("delete files", "reach
     * the network"), not about which backend or which runtime would produce it, a yes to force-pushing from Bash
     * answered the consequence, and asking again because the next attempt is a script is the same card twice. */
    const granted = new Set<CommandClass>();

    return {
        enforcing: true,
        async *consult(program, subject) {
            const classes = classifyCommand(program).filter((commandClass) => !granted.has(commandClass));
            const held = classes.length === 0 ? undefined : decide(classes, options.rules, options.taint.source());
            if (held === undefined) {
                return ALLOWED;
            }
            if (held.verdict.effect === "deny") {
                return { allow: false, reason: held.verdict.reason };
            }
            if (options.unattended) {
                return {
                    allow: false,
                    reason:
                        `${held.verdict.reason}, and this turn is running unattended: there is nobody to approve it. ` +
                        `Do not retry: carry on with what you can do without this command, and say plainly what you left undone.`,
                };
            }
            if (options.canPark === false) {
                return {
                    allow: false,
                    reason:
                        `${held.verdict.reason}, and this agent cannot pause to ask: it was refused instead. ` +
                        `Do not retry: carry on with what you can do without this command, and say plainly what you left undone. ` +
                        `The owner can change the rule, or run this on an agent that can ask.`,
                };
            }
            const { id, wait } = createRequest("permission", {
                kind: "permission",
                requestId: "",
                decision: "deny",
                feedback: "The turn ended before you answered.",
            });
            yield {
                kind: "permission",
                requestId: id,
                toolName: subject.toolName,
                title: `This ${subject.noun} would ${COMMAND_CLASS_LABELS[held.commandClass]}`,
                displayName: subject.displayName,
                description: program.slice(0, SHOWN),
                reason: held.verdict.reason,
                alwaysLabel: `Allow everything that would ${COMMAND_CLASS_LABELS[held.commandClass]} this turn`,
            };
            const { reply, resolved } = await wait(options.signal);
            // Every parked card owes the stream its resolution frame: it is what freezes the card in a replayed
            // transcript, and the only honest account of how long the turn was parked.
            yield resolved;
            if (reply.decision === "deny") {
                // A denial with feedback is a redirection and the turn takes it; a bare one is the user
                // stopping this command, so say that rather than inviting a way around it.
                return {
                    allow: false,
                    reason:
                        reply.feedback?.trim() ||
                        `The user declined this. Do not run it, and do not look for another way to achieve the same thing: wait for them to say how to proceed.`,
                };
            }
            if (reply.decision === "always") {
                granted.add(held.commandClass);
            }
            return ALLOWED;
        },
    };
};

/* WHAT THE CLAUDE PATH READS, every tool whose input IS a program this turn is about to run, and the field that
 * carries it. Bash and the JS execution backend are one question to the owner's rulebook, judged by the one
 * classifier: its patterns are unanchored substrings, so a `.env` path or an `npm publish` inside a script's
 * spawn call lands in the same class it would on a command line, and a script that assembles the string at
 * runtime walks past it, which is exactly the honesty the classifier already claims for creatively quoted
 * shell. One gate over both backends, or a rule the owner wrote for "commands" would silently not apply to
 * the other way of running things. */
const EXECUTION_SOURCES = [
    { field: "command", subject: BASH_SUBJECT },
    { field: "code", subject: JS_SUBJECT },
] as const;

const refuse = (reason: string): { hookSpecificOutput: Record<string, unknown> } => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/* The Claude Code transport over the gate above: a hook is a callback, so its frames go out through the `push`
 * the turn handed us rather than by yielding.
 *
 * Takes the OPTIONS plus a push rather than a built gate, because the "always" grants must be shared across both
 * of its matchers and a caller handing one gate to each would ask twice. */
export const commandGateHooks = (
    options: CommandGateOptions & { readonly push: (event: AgentEvent) => void },
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const gate = createCommandGate(options);
    const gateFor =
        (source: (typeof EXECUTION_SOURCES)[number]) =>
        async (input: { hook_event_name: string; tool_input?: unknown }): Promise<Record<string, unknown>> => {
            if (input.hook_event_name !== "PreToolUse") {
                return {};
            }
            const program = (input.tool_input as Record<string, unknown>)[source.field];
            if (typeof program !== "string") {
                return {};
            }
            const outcome = await consultWith(gate, program, source.subject, options.push);
            return outcome.allow ? {} : refuse(outcome.reason);
        };
    return {
        PreToolUse: EXECUTION_SOURCES.map((source) => ({ matcher: source.subject.toolName, hooks: [gateFor(source)] })),
    };
};
