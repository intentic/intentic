import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import {
    type AgentEvent,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandContext,
    type CommandJudgeMode,
    type CommandLocus,
    type CommandMatch,
    type CommandSpan,
    matchCommand,
    mergeSpans,
    type ProgramAsk,
    type SafetyLogEntry,
    type SafetyVerdict,
} from "@intentic/sandbox-contract";
import { createRequest } from "../agent/tools/agent-requests.js";
import type { JudgeFacts } from "../agent/tools/command-judge.js";
import { RoleModelUnsetError } from "../agent/models/role-model-unset.js";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { commandRun } from "./actions.js";
import { createCredentialOracle } from "./credential-files.js";
import { guard } from "./guard.js";
import { excerptProgram } from "../safety/safety-log.js";
import type { TurnTaint } from "./turn-taint.js";

// Second layer under the admission floor (guard/actions.ts sessionStart): what an already-running session's commands
// may do. Four tiers run in `consult`: triage, an un-waivable hard rule, a judge, then a person; only the last
// interrupts anyone, and an unattended turn gets a refusal instead of a card.

export interface CommandGateOptions {
    // The owner's policy text, snapshotted once per turn; edits take effect on the next turn, not mid-turn.
    readonly policy: string;
    // Mode (off/watch/on), snapshotted per turn like the policy; the hard rule applies at every setting.
    readonly judging: CommandJudgeMode;
    // Nobody at a composer (automation, loop, chore); an ask refuses instead of parking, and the judge is told.
    readonly unattended: boolean;
    // Whether this transport can pause for an answer; false if the runtime's own watchdog aborts a paused turn.
    readonly canPark?: boolean;
    // The turn's own signal, so a parked card settles when the turn is stopped instead of holding it open.
    readonly signal: AbortSignal;
    // Where the command will run, so a credential-shaped path can be resolved and checked rather than assumed.
    readonly cwd?: string;
    // This turn's outside-content bit (guard/turn-taint.ts), read per command rather than snapshotted.
    readonly taint: TurnTaint;
    // Asks the judge; a rejection means no rung answered. Callback-shaped, so this module knows nothing about accounts
    // or quotas.
    readonly judge?: ((program: string, facts: JudgeFacts, signal: AbortSignal) => Promise<SafetyVerdict>) | undefined;
    // Logs every judged command, allowed ones too, fire-and-forget so a failure here can't block the command.
    readonly log?: ((entry: SafetyLogEntry) => void) | undefined;
    // Amends a logged `ask` once answered, keyed by when the verdict was reached, not when the card settles.
    readonly answered?: ((at: number, answer: SafetyLogEntry["answer"], outcome: SafetyLogEntry["outcome"]) => void) | undefined;
    // Which owner computer this judges for, absent for the sandbox itself; selects the matching policy half.
    readonly machine?: string | undefined;
    // Appends a line the owner accepted (the Always button) to their policy; absent offers no Always button.
    readonly remember?: ((line: string) => Promise<void>) | undefined;
}

// How much of the command the card shows: long enough to identify a heredoc, short enough to stay a card.
const SHOWN = 400;

// How the excerpt splits when the flagged fragment sits past a head-only cut: `HEAD` chars identify the program, `LEAD`
// chars of run-up keep the fragment in context.
const HEAD = 120;
const LEAD = 40;

// What's about to run, in the words the card will use. Carried by the caller, since only it knows whether this is a
// shell line, a script, or a vendor tool call.
export interface GateSubject {
    // Cards file under this tool name, matching both the client's rendering and the SDK hook.
    readonly toolName: string;
    // The card's chip: "Run command", "Run code".
    readonly displayName: string;
    // Word for the thing being held; used only when the hard rule writes the card's title.
    readonly noun: string;
    // Which grammar colours the card and names it in the explainer's prompt (Shiki's names).
    readonly language: ProgramAsk["language"];
}

const BASH_SUBJECT: GateSubject = { toolName: "Bash", displayName: "Run command", noun: "command", language: "bash" };
const JS_SUBJECT: GateSubject = { toolName: JS_TOOL_NAME, displayName: "Run code", noun: "script", language: "javascript" };

// A vendor runtime's own command tool, whatever it's called; one subject serves all of them.
export const vendorSubject = (toolName: string): GateSubject => ({ toolName, displayName: "Run command", noun: "command", language: "bash" });

// Clips spans to one segment and rebases them onto it, so a span straddling the edge stops there too.
const spansWithin = (spans: readonly CommandSpan[], from: number, to: number, shift: number): CommandSpan[] =>
    spans
        .filter((span) => span.start < to && span.end > from)
        .map((span) => ({ start: Math.max(span.start, from) + shift, end: Math.min(span.end, to) + shift }));

// States the elided character count instead of trailing off; bracketed so it reads as an insertion.
const elision = (count: number): string => `\n[… ${count} character${count === 1 ? `` : `s`} not shown …]\n`;

// Excerpt for the card: enough of the program to judge, with the matched spans intact. Splits into head + fragment
// window (eliding the middle) when a flagged fragment would otherwise fall outside a head-only cut.
const programAsk = (program: string, subject: GateSubject, matches: readonly CommandMatch[], held: CommandClass | undefined): ProgramAsk => {
    const spans: readonly CommandSpan[] = mergeSpans(
        matches.filter((match) => held === undefined || match.commandClass === held).flatMap((match) => match.spans),
    );
    const language = subject.language;
    if (program.length <= SHOWN) {
        return { text: program, language, truncated: false, spans: [...spans] };
    }
    // Mark already fits inside a plain head cut; taking one avoids an elision that would skip nothing.
    const first = spans[0];
    if (first === undefined || first.end <= SHOWN) {
        return { text: program.slice(0, SHOWN), language, truncated: true, spans: spansWithin(spans, 0, SHOWN, 0) };
    }
    const from = first.start - LEAD;
    // Mark starts inside (or near) the head and only its tail runs long: a head cut already reaches it.
    if (from <= HEAD) {
        return { text: program.slice(0, SHOWN), language, truncated: true, spans: spansWithin(spans, 0, SHOWN, 0) };
    }
    const head = program.slice(0, HEAD);
    const gap = elision(from - HEAD);
    const window = program.slice(from, from + (SHOWN - HEAD));
    return {
        text: `${head}${gap}${window}`,
        language,
        truncated: true,
        spans: [...spansWithin(spans, 0, HEAD, 0), ...spansWithin(spans, from, from + window.length, head.length + gap.length - from)],
    };
};

// Allow, run it. Refuse, do not, and hand `reason` back to the model as the refusal.
export type GateOutcome = { readonly allow: true } | { readonly allow: false; readonly reason: string };

const ALLOWED: GateOutcome = { allow: true };

export interface CommandGate {
    // Whether anything can refuse this turn; runtimes read it before deciding to enable their approval channel.
    readonly enforcing: boolean;
    // A generator, not a Promise+push callback: a vendor runtime already inside its own for-await loop can `yield*` the
    // card in place. A promise+push shape would deadlock exactly that caller.
    readonly consult: (program: string, subject: GateSubject) => AsyncGenerator<AgentEvent, GateOutcome>;
}

// Drives a consult from a caller that emits by callback rather than by yielding: every frame goes to `push` in order,
// and the verdict comes back.
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

// Every command here runs in this container; a device command is judged in hosts/host-command-gate.ts instead.
const SANDBOX: CommandLocus = "sandbox";

// Takes matches, not classes, so `live` rides along: a class whose every fragment sits in a heredoc, comment or quoted
// arg is one the hard rule declines. One consult per class, not a decide handed a list.
const hardRuled = (matches: readonly CommandMatch[]): CommandClass | undefined =>
    matches.find((match) => guard(commandRun, { commandClass: match.commandClass, locus: SANDBOX, live: match.live }).effect !== "allow")
        ?.commandClass;

// Why a command can't be asked about (or undefined if a card can be raised): both branches are properties of the turn,
// not the policy. Each refusal tells the model not to retry.
const cannotAsk = (reason: string, options: CommandGateOptions): GateOutcome | undefined => {
    if (options.unattended) {
        return {
            allow: false,
            reason:
                `${reason} This turn is running unattended: there is nobody to approve it. ` +
                `Do not retry: carry on with what you can do without this command, and say plainly what you left undone.`,
        };
    }
    if (options.canPark === false) {
        return {
            allow: false,
            reason:
                `${reason} This agent cannot pause to ask, so it was refused instead. ` +
                `Do not retry: carry on with what you can do without this command, and say plainly what you left undone. ` +
                `The owner can change their safety policy, or run this on an agent that can ask.`,
        };
    }
    return undefined;
};

// Judge unreachable: falls back to the hard rule, allowing everything else.
const JUDGE_UNAVAILABLE = `The safety judge could not be reached, so this was decided by the standing rule alone.`;

// Same posture as JUDGE_UNAVAILABLE, worded differently since `off` is a choice, not a fault.
const JUDGE_OFF = `The safety judge is turned off, so this was decided by the standing rule alone.`;

// Same posture again: judge is on but no model is set for it, a choice rather than a fault.
const JUDGE_UNSET = `No model is set for the safety judge, so this was decided by the standing rule alone.`;

export const createCommandGate = (options: CommandGateOptions): CommandGate => {
    // Programs the user has already said yes to this turn, keyed by exact text so a yes means only this command.
    const granted = new Set<string>();
    // Judged verdicts this turn, keyed by program; concurrent consults of the same program share one promise.
    const judged = new Map<string, Promise<SafetyVerdict>>();
    // Fact-check for secrets.access; re-read every command since a watched file's contents can change mid-turn.
    const context: CommandContext = { locus: SANDBOX, holdsSecret: createCredentialOracle(options.cwd) };

    const record = (entry: Omit<SafetyLogEntry, "at">, at: number): void => {
        options.log?.({ at, ...entry });
    };

    // Asks the judge once per (taint state, program): taint changes mid-turn only toward stricter, so a command allowed
    // before a page was read is re-judged after.
    const askJudge = (program: string, facts: JudgeFacts): Promise<SafetyVerdict> => {
        // NUL-separated: the one character neither a taint source nor a shell command can contain.
        const key = `${facts.outsideSource ?? ``}\u0000${program}`;
        const existing = judged.get(key);
        if (existing !== undefined) {
            return existing;
        }
        // Rejections aren't cached, so a momentarily unreachable judge doesn't condemn every later command.
        const asking = (options.judge?.(program, facts, options.signal) ?? Promise.reject(new Error(`no judge`))).catch((error: unknown) => {
            judged.delete(key);
            throw error;
        });
        judged.set(key, asking);
        return asking;
    };

    return {
        enforcing: true,
        async *consult(program, subject) {
            // Matched, not merely classified, so the fired fragments are in hand if this ends on a card.
            const matches = matchCommand(program, context);
            // Tier 1: nothing matched, nothing to judge; the overwhelming majority of commands stop here for free.
            if (matches.length === 0) {
                return ALLOWED;
            }
            const classes = matches.map((match) => match.commandClass);
            const at = Date.now();
            const outsideSource = options.taint.source();
            // Tier 1.5, the hard rule: un-waivable, applied first, and the only verdict allowed to title the card.
            const hard = hardRuled(matches);
            const facts: JudgeFacts = {
                consequences: classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]),
                unattended: options.unattended,
                language: subject.language,
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(outsideSource === undefined ? {} : { outsideSource }),
                ...(options.machine === undefined ? {} : { machine: options.machine }),
            };
            // Tier 2: an unreachable judge leaves the hard rule standing and allows the rest; `off` never asks at all.
            const verdict: SafetyVerdict =
                options.judging === "off"
                    ? { decision: "allow", sentence: JUDGE_OFF }
                    : await askJudge(program, facts).catch(
                          (error: unknown): SafetyVerdict => ({
                              decision: "allow",
                              sentence: error instanceof RoleModelUnsetError ? JUDGE_UNSET : JUDGE_UNAVAILABLE,
                          }),
                      );
            // What's enforced, not what was said: only `on` obeys the verdict; `off` and `watch` never do.
            const enforced = options.judging === "on" ? verdict.decision : "allow";
            // The hard rule can only make a verdict stricter, never looser: allow becomes ask, refuse stays refuse.
            const decision = hard !== undefined && enforced === "allow" ? "ask" : enforced;
            // Row keeps the judge's own word, not the enforced one, so ask-but-allowed stays distinct from
            // allow-but-asked.
            const entry = { program: excerptProgram(program), classes, decision: verdict.decision, sentence: verdict.sentence };
            if (decision === "allow") {
                // At `off` there's no verdict to log; a row saying "allowed, nobody looked" would just repeat the
                // setting.
                if (options.judging !== "off") {
                    record({ ...entry, outcome: "allowed" }, at);
                }
                return ALLOWED;
            }
            if (decision === "refuse") {
                record({ ...entry, outcome: "refused" }, at);
                return { allow: false, reason: `${verdict.sentence} Refused by your owner's safety policy. Do not retry.` };
            }
            // Checked after the judge, not before, so the log still records what would have happened.
            if (granted.has(program)) {
                record({ ...entry, outcome: "allowed", answer: "allowed" }, at);
                return ALLOWED;
            }
            const unaskable = cannotAsk(verdict.sentence, options);
            if (unaskable !== undefined) {
                record({ ...entry, outcome: "refused" }, at);
                return unaskable;
            }
            const { id, wait } = createRequest("permission", {
                kind: "permission",
                requestId: "",
                decision: "deny",
                feedback: "The turn ended before you answered.",
            });
            record({ ...entry, outcome: "asked" }, at);
            // Title is the judge's own sentence; the hard rule instead titles its named consequence.
            yield {
                kind: "permission",
                requestId: id,
                toolName: subject.toolName,
                title: hard === undefined ? verdict.sentence : `This ${subject.noun} would ${COMMAND_CLASS_LABELS[hard]}`,
                displayName: subject.displayName,
                program: programAsk(program, subject, matches, hard),
                ...(hard === undefined ? {} : { explain: verdict.sentence }),
                // Label is the exact line to add, so nobody accepts a rule unread; shown only when there is one to
                // remember.
                ...(verdict.policyLine !== undefined && options.remember !== undefined
                    ? { alwaysLabel: `Always: ${verdict.policyLine}` }
                    : {}),
            };
            const { reply, resolved } = await wait(options.signal);
            // Every parked card owes the stream its resolution frame, for a replayed transcript and an honest wait
            // time.
            yield resolved;
            if (reply.decision === "deny") {
                options.answered?.(at, "declined", "refused");
                // Feedback present means a redirection; a bare denial means the user is stopping this, so say that
                // plainly.
                return {
                    allow: false,
                    reason:
                        reply.feedback?.trim() ||
                        `The user declined this. Do not run it, and do not look for another way to achieve the same thing: wait for them to say how to proceed.`,
                };
            }
            options.answered?.(at, "allowed", "allowed");
            granted.add(program);
            if (reply.decision === "always" && verdict.policyLine !== undefined) {
                // Not awaited and failures are swallowed: the command already ran, so a write failure shouldn't matter.
                void options.remember?.(verdict.policyLine).catch(() => undefined);
            }
            return ALLOWED;
        },
    };
};

// Bash and the JS backend are one question to the rulebook: the classifier's patterns are unanchored substrings, so
// both get judged alike. One gate over both, or a command rule wouldn't reach the other.
const EXECUTION_SOURCES = [
    { field: "command", subject: BASH_SUBJECT },
    { field: "code", subject: JS_SUBJECT },
] as const;

const refuse = (reason: string): { hookSpecificOutput: Record<string, unknown> } => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

// Claude Code transport over the gate: a hook is a callback, so frames go out via the `push` passed in. Takes options
// plus push rather than a built gate, so "always" grants are shared across both matchers.
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
