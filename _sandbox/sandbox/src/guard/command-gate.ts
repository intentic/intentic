import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import {
    type AdmissionRule,
    type AgentEvent,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandContext,
    type CommandMatch,
    type CommandSpan,
    matchCommand,
    type ProgramAsk,
} from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { commandRun } from "./actions.js";
import { createCredentialOracle } from "./credential-files.js";
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
 * into a refusal pointing at the approvals queue. A send has a held form, the approval IS the message, waiting,
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
    /* WHERE THE COMMAND WILL RUN, which is what lets `secrets.access` check its guess instead of asserting it: a
     * credential-shaped path is resolved against this and read, and a file with nothing in it stops raising a
     * card that says it holds a credential (guard/credential-files.ts). Absent ⇒ only absolute and `~` paths can
     * be checked, and a relative one keeps the class on the strength of its name, as it always did. */
    readonly cwd?: string;
    /* This turn's outside-content bit (guard/turn-taint.ts), READ per command rather than snapshotted: the
     * page that taints a turn usually arrives mid-turn, several tool calls before the command that matters. */
    readonly taint: TurnTaint;
    /* TRANSLATE A HELD PROGRAM INTO ONE SENTENCE FOR THE CARD, when the owner switched that on
     * (SandboxSettings.explainCommands). Absent ⇒ cards go out with the program alone, which is the default.
     *
     * A CALLBACK RATHER THAN `Services`, so this module keeps knowing nothing about accounts, provider chains
     * or quotas: the wiring that owns those (agent/turn-plan.ts) hands down a function, and the gate's own test
     * suite can hand down a stub without standing up a quick model. Resolving to undefined is the ordinary
     * answer for "no sentence worth showing", and a rejection is treated the same way.
     *
     * Explicitly `| undefined` rather than bare-optional so a caller can forward its own maybe-absent field in
     * one assignment: under exactOptionalPropertyTypes the bare form makes every call site spread a
     * conditional, which is a branch apiece for a value that means the same thing present-and-undefined as
     * absent. */
    readonly explain?: ((program: string, language: ProgramAsk["language"], signal: AbortSignal) => Promise<string | undefined>) | undefined;
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
    // Which grammar colours it on the card, and which word the explainer's prompt uses for it. The two
    // execution backends, named as Shiki names them.
    readonly language: ProgramAsk["language"];
}

const BASH_SUBJECT: GateSubject = { toolName: "Bash", displayName: "Run command", noun: "command", language: "bash" };
const JS_SUBJECT: GateSubject = { toolName: JS_TOOL_NAME, displayName: "Run code", noun: "script", language: "javascript" };

// A vendor runtime's own command tool, whatever it calls it. One subject for all of them: the card names the
// consequence, and which vendor tool carried it is in the transcript beside it either way.
export const vendorSubject = (toolName: string): GateSubject => ({ toolName, displayName: "Run command", noun: "command", language: "bash" });

/* THE PROGRAM AS THE CARD WILL HOLD IT: the head of it, and the marked fragments that survive the cut.
 *
 * The spans come from the classifier (matchCommand), so the card marks what the RULE fired on rather than
 * re-running the patterns in a browser and marking whatever a second copy of them found. Clipping them here is
 * what keeps that true after truncation: an offset past `SHOWN` points into text nobody was sent, and a span
 * left straddling the cut would paint to the end of a string that ends somewhere else. A hold whose every
 * fragment sits past the cut keeps its card and simply has nothing to mark, which is honest, the reason is
 * still in the title and the `Show all` toggle still reaches the rest.
 *
 * ONLY THE HELD CLASS'S fragments. The title says which consequence stopped this ("would read credential
 * material"), so marking a second matched class's fragments beside it would point at text nobody is being asked
 * about, under a sentence that does not describe it. */
const programAsk = (program: string, subject: GateSubject, matches: readonly CommandMatch[], held: CommandClass): ProgramAsk => {
    const text = program.slice(0, SHOWN);
    const spans: readonly CommandSpan[] = matches.find((match) => match.commandClass === held)?.spans ?? [];
    return {
        text,
        language: subject.language,
        truncated: program.length > text.length,
        spans: spans.filter((span) => span.start < text.length).map((span) => ({ start: span.start, end: Math.min(span.end, text.length) })),
    };
};

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

/* The strictest verdict across the classes the command fell in, with the class that produced it, a deny beats
 * a hold beats nothing, matching the admission floor's own most-restrictive-wins. Undefined ⇒ every class allows.
 *
 * ONE CLASS PER CONSULT, still, which is what keeps "most restrictive wins" observable here rather than hidden
 * inside a decide that was handed a list — but each consult is told whether the command ALSO reaches out, because
 * one rule is about the pair rather than the class: a tainted turn's credential read is held when it leaves in
 * the same command (guard/actions.ts taintFloorHolds argues why). Computed once from the classes already
 * matched, so the pair costs no second walk of the command. */
const decide = (
    classes: readonly CommandClass[],
    rules: CommandGateOptions["rules"],
    outsideSource: string | undefined,
    egress: boolean,
): { commandClass: CommandClass; verdict: GuardVerdict } | undefined => {
    let held: { commandClass: CommandClass; verdict: GuardVerdict } | undefined;
    for (const commandClass of classes) {
        const verdict = guard(commandRun, { commandClass, rules, egress, ...(outsideSource !== undefined ? { outsideSource } : {}) });
        if (verdict.effect === "deny") {
            return { commandClass, verdict };
        }
        if (verdict.effect === "hold" && held === undefined) {
            held = { commandClass, verdict };
        }
    }
    return held;
};

/* THE THREE WAYS A HELD COMMAND IS REFUSED WITHOUT EVER REACHING A CARD, in the words the model reads back.
 * Undefined ⇒ raise the card and wait, which is the ordinary path.
 *
 * Lifted out of `consult` because they are one question ("can this be asked at all, and of whom") answered
 * before anything about cards, waiting or explaining begins, and leaving them inline put four unrelated
 * decisions in one function. Each refusal tells the model not to retry, for the reason each header gives: a
 * turn that works around a refusal it was just given is the failure these sentences exist to prevent. */
const refusalFor = (verdict: GuardVerdict, options: CommandGateOptions): GateOutcome | undefined => {
    if (verdict.effect === "deny") {
        return { allow: false, reason: verdict.reason };
    }
    if (options.unattended) {
        return {
            allow: false,
            reason:
                `${verdict.reason}, and this turn is running unattended: there is nobody to approve it. ` +
                `Do not retry: carry on with what you can do without this command, and say plainly what you left undone.`,
        };
    }
    if (options.canPark === false) {
        return {
            allow: false,
            reason:
                `${verdict.reason}, and this agent cannot pause to ask: it was refused instead. ` +
                `Do not retry: carry on with what you can do without this command, and say plainly what you left undone. ` +
                `The owner can change the rule, or run this on an agent that can ask.`,
        };
    }
    return undefined;
};

/* THE PLAIN SENTENCE FOR A CARD ALREADY ON SCREEN, or nothing at all. Yields at most one `permission_note`.
 *
 * A SECOND FRAME RACED AGAINST THE ANSWER, which is the whole design and the reason it is not a field on the
 * card. The card is up and the person may settle it in two seconds; the quick model may take considerably
 * longer, because its chain steps over spent accounts one refusal at a time. So `settling` — the waiter, already
 * started by the caller — is the other runner, and if the person wins there is nothing to say: a note for a card
 * that has already resolved is a frame arriving after `resolved`, which every client would then have to learn to
 * ignore.
 *
 * A REJECTION IS SILENCE. Nothing connected, a chain spent to the bottom, a credential that failed resolution:
 * none of that is anything the person answering this card can act on, and none of it changes what the card
 * says. The card was complete when it went out. */
async function* explanationFrames(
    requestId: string,
    program: string,
    subject: GateSubject,
    options: CommandGateOptions,
    settling: Promise<unknown>,
): AsyncGenerator<AgentEvent> {
    if (options.explain === undefined) {
        return;
    }
    const explained = await Promise.race([
        options.explain(program, subject.language, options.signal).catch(() => undefined),
        settling.then(() => undefined),
    ]);
    if (explained !== undefined && explained !== "") {
        yield { kind: "permission_note", requestId, explain: explained };
    }
}

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
    /* The fact-check under `secrets.access`, bound once per turn. It reads the file a credential-shaped path
     * names and drops the class when there is demonstrably no credential in it — see guard/credential-files.ts
     * for what it will and will not answer, and the contract's CommandContext for why only a positive "no"
     * counts. Not cached across commands on purpose: a turn that writes a token into `.env` and then reads it
     * back must be judged on the file as it is at each consult, not as it was at the first. */
    const context: CommandContext = { holdsSecret: createCredentialOracle(options.cwd) };

    return {
        enforcing: true,
        async *consult(program, subject) {
            // Matched rather than merely classified, so the fragments that fired are in hand if this ends on a
            // card. An allowed command drops them a line later and pays only the offsets the same walk collected.
            const matches = matchCommand(program, context);
            /* Read from EVERY class the command fell in, not from the ones still to be judged: a yes to
             * reaching the internet earlier this turn answered that consequence, and it must not also answer
             * the different question of whether a credential read leaves in the same command. */
            const egress = matches.some((match) => match.commandClass === "network.outbound");
            const pending = matches.filter((match) => !granted.has(match.commandClass));
            const held =
                pending.length === 0
                    ? undefined
                    : decide(
                          pending.map((match) => match.commandClass),
                          options.rules,
                          options.taint.source(),
                          egress,
                      );
            if (held === undefined) {
                return ALLOWED;
            }
            const refused = refusalFor(held.verdict, options);
            if (refused !== undefined) {
                return refused;
            }
            const { id, wait } = createRequest("permission", {
                kind: "permission",
                requestId: "",
                decision: "deny",
                feedback: "The turn ended before you answered.",
            });
            // The card carries the program AS A PROGRAM, with the fragments its own held class fired on.
            yield {
                kind: "permission",
                requestId: id,
                toolName: subject.toolName,
                title: `This ${subject.noun} would ${COMMAND_CLASS_LABELS[held.commandClass]}`,
                displayName: subject.displayName,
                program: programAsk(program, subject, matches, held.commandClass),
                reason: held.verdict.reason,
                alwaysLabel: `Allow everything that would ${COMMAND_CLASS_LABELS[held.commandClass]} this turn`,
            };
            // The waiter is started BEFORE the sentence is asked for, so the two race; see explanationFrames.
            const settling = wait(options.signal);
            yield* explanationFrames(id, program, subject, options, settling);
            const { reply, resolved } = await settling;
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
