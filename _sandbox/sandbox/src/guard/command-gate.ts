import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import {
    type AgentEvent,
    COMMAND_CLASS_LABELS,
    type CommandClass,
    type CommandContext,
    type CommandMatch,
    type CommandSpan,
    matchCommand,
    type ProgramAsk,
    type SafetyLogEntry,
    type SafetyVerdict,
} from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import type { JudgeFacts } from "../agent/command-judge.js";
import { JS_TOOL_NAME } from "../execution/js-tool.js";
import { commandRun } from "./actions.js";
import { createCredentialOracle } from "./credential-files.js";
import { guard } from "./guard.js";
import { excerptProgram } from "../safety/safety-log.js";
import type { TurnTaint } from "./turn-taint.js";

/* THE SECOND LAYER, under the admission floor. The floor (guard/actions.ts sessionStart) decides who may wake
 * the agent at all; this decides what a session that is ALREADY RUNNING may do, which is the only question
 * left once a turn is underway, and the one the permission card cannot answer on its own.
 *
 * It cannot, because the posture every interesting turn runs in is bypassPermissions: the container is the
 * isolation boundary, so `canUseTool` is never consulted, and an automation wake never had a person at a
 * composer to consult anyway.
 *
 * FOUR TIERS, AND ONLY THE LAST ONE INTERRUPTS ANYBODY. The contract's safety-policy.ts argues the design; this
 * is where tiers 1 to 3 actually happen, in `consult`, in this order:
 *
 *   1 TRIAGE      matchCommand, the regex catalog. Its verdict is no longer the card — it only decides that a
 *                 judge should look. Nothing matched ⇒ the command runs and nothing was spent.
 *   1½ HARD RULE  guard/actions.ts commandRun, applied BEFORE the judge and un-waivable by it. One class today.
 *   2 JUDGE       a quick model reading the owner's written policy, the program as data, and the daemon's own
 *                 facts about the turn (agent/command-judge.ts). Answers allow, ask or refuse.
 *   3 PERSON      the card, raised only on `ask`, carrying the judge's sentence.
 *
 * WHAT THIS REPLACED, because the shape only makes sense against it: the classifier's match WAS the verdict, and
 * the owner tuned six per-class switches over it. So `echo "rm -rf /"` into a README, `rg 'rm -rf'`, a heredoc
 * writing a deploy script and a real recursive delete were one question with one answer, and the answer was an
 * interruption. The cost of a triage false positive is now one model call rather than one interruption, which is
 * what makes it affordable for triage to be over-inclusive and for the person to be asked rarely.
 *
 * TWO LAYERS IN THIS FILE, and the split is the point.
 *
 * `createCommandGate` is the DECISION, and it knows nothing about how a runtime asks. Every runtime gets the
 * same verdict from the same judge against the same policy for the same command, which is what makes a line the
 * owner wrote a rule rather than a Claude Code rule.
 *
 * `commandGateHooks` is one TRANSPORT over that decision: a PreToolUse hook, which fires even under
 * bypassPermissions and for subagents too, so it holds exactly where the cards never do. The other transports
 * live with the runtimes that speak them, because the vendor's protocol is theirs and not this module's
 * business: Codex answers `item/commandExecution/requestApproval` (codex/codex-agent.ts, codexCommandApproval),
 * and an ACP agent answers `session/request_permission` (acp/acp-permissions.ts).
 * They differ in ONE stated way, and the capability record carries it (`rulebook: "approval"`): the vendor
 * decides which calls it asks about, so a command it never raises is one no policy can reach. What it does
 * raise is judged here.
 *
 * AN ASK PARKS THE TURN. That is the whole difference from the outbound gate next door, which translates a hold
 * into a refusal pointing at the approvals queue. A send has a held form, the approval IS the message, waiting,
 * and `git push --force` has none: there is the command or there is not the command. So an ask raises the same
 * permission card the SDK's own prompts use (agent-requests.ts mints it, the client renders it, /agent/reply
 * answers it) and the caller simply waits, which every transport here is allowed to do.
 *
 * UNLESS NOBODY IS THERE. An unattended turn gets the refusal, for the reason permissionGate gives at its own
 * unattended branch: a card raised where no one can answer hangs the turn until its timeout and reads as the
 * agent freezing, which is worse than a clear no. Note what changed, though: the JUDGE is told nobody is
 * watching (JudgeFacts.unattended) and the policy has a section about it, so an automation that used to have
 * every held command refused now gets most of them allowed on the owner's own written say-so, and only a
 * genuine `ask` becomes a refusal.
 *
 * Read sandbox-contract's command-classes.ts for what triage does and does not catch, and command-judge.ts for
 * what the judge can be argued into: neither is the boundary, and this file has never claimed to be one. The
 * boundaries are structural and elsewhere.
 */

export interface CommandGateOptions {
    /* THE OWNER'S POLICY, as text, resolved once when the turn was planned. The judge's instructions, and the
     * only thing in this module that decides anything the hard rule does not.
     *
     * Snapshotted per turn rather than read per command, deliberately: a turn judged against three different
     * versions of the policy because the owner was editing it mid-turn is a turn nobody can account for
     * afterwards, and the log would be recording verdicts against a document that no longer exists. An edit
     * takes effect on the next turn, which is also when the agent's own edits to it take effect. */
    readonly policy: string;
    // Nobody is at a composer: an automation wake, a loop iteration, a chore. An ask refuses instead of parking,
    // and the judge is told so before it decides (JudgeFacts.unattended).
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
    /* ASK THE JUDGE. Rejecting means no rung answered, and the caller decides what that means (see
     * `unavailableOutcome` below), which is why this is allowed to throw rather than resolving to undefined.
     *
     * A CALLBACK RATHER THAN `Services`, so this module keeps knowing nothing about accounts, provider chains
     * or quotas: the wiring that owns those (agent/turn-plan.ts) hands down a function, and the gate's own test
     * suite can hand down a stub without standing up a quick model.
     *
     * Explicitly `| undefined` rather than bare-optional so a caller can forward its own maybe-absent field in
     * one assignment: under exactOptionalPropertyTypes the bare form makes every call site spread a
     * conditional, which is a branch apiece for a value that means the same thing present-and-undefined as
     * absent. Absent ⇒ every triage hit takes the judge-unavailable path, which is what a bench turn and a
     * sandbox with nothing connected both get. */
    readonly judge?: ((program: string, facts: JudgeFacts, signal: AbortSignal) => Promise<SafetyVerdict>) | undefined;
    /* WRITE THE VERDICT DOWN. Every judged command, including the allowed ones — those are the entries the owner
     * cannot learn about any other way, and "why wasn't I asked about that" is the question the Safety page's
     * log exists to answer. Absent ⇒ nothing is recorded, which is right for a bench turn and for tests.
     *
     * Fire-and-forget by contract: the returned promise is not awaited and a rejection is swallowed, because a
     * full disk must not stop a command the owner's policy allows. */
    readonly log?: ((entry: SafetyLogEntry) => void) | undefined;
    /* AMEND A LOGGED `ask` ONCE THE PERSON ANSWERS IT, keyed by the moment the verdict was reached. The verdict
     * is written when it is REACHED rather than when the card settles, because a turn can be stopped while a
     * card is up and a verdict that was never written is one the owner cannot find out about; this fills in how
     * it ended. Same fire-and-forget contract as `log`. */
    readonly answered?: ((at: number, answer: SafetyLogEntry["answer"], outcome: SafetyLogEntry["outcome"]) => void) | undefined;
    /* WHICH OF THE OWNER'S COMPUTERS this gate is judging for, absent for the sandbox's own shell. Selects the
     * half of the policy that applies, and the two halves are deliberately very different: everything in the
     * container is disposable and nothing on somebody's laptop is. Set by the host bridge (hosts/host.routes.ts),
     * which judges a machine's `run_command` before it crosses the tunnel. */
    readonly machine?: string | undefined;
    /* ADD A LINE THE OWNER ACCEPTED ON A CARD to their policy. What the Always button does now: the judge
     * proposes the line, the owner reads it before clicking, and it lands in a document they can edit later —
     * rather than a hidden grant in a settings file, which is the thing the redesign set out to remove.
     *
     * Absent ⇒ no Always button is offered at all, which is the honest shape when nothing could remember an
     * answer (the schema already says to send `alwaysLabel` only when there is something to remember). */
    readonly remember?: ((line: string) => Promise<void>) | undefined;
}

// How much of the command the card shows. Long enough for a heredoc's first lines to identify what this is,
// short enough that the card stays a card, the full text is in the transcript either way.
const SHOWN = 400;

/* HOW THE BUDGET IS SPLIT when the flagged fragment sits past a head-only cut. The head identifies what this
 * is (`cat > repro.mjs <<'EOF'`, `pnpm exec …`); the rest is spent on the fragment the title is about, plus
 * `LEAD` characters of run-up so the mark arrives with the words around it rather than mid-token. */
const HEAD = 120;
const LEAD = 40;

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

// The fragments of one segment of the excerpt, clipped to it and moved onto the excerpt's own ruler: a span
// straddling an edge would otherwise paint to the end of a string that ends somewhere else.
const spansWithin = (spans: readonly CommandSpan[], from: number, to: number, shift: number): CommandSpan[] =>
    spans
        .filter((span) => span.start < to && span.end > from)
        .map((span) => ({ start: Math.max(span.start, from) + shift, end: Math.min(span.end, to) + shift }));

// What stands in for the characters between the two segments. Says how many rather than trailing off, and is
// bracketed so it cannot be mistaken for part of the program it interrupts.
const elision = (count: number): string => `\n[… ${count} character${count === 1 ? `` : `s`} not shown …]\n`;

/* THE PROGRAM AS THE CARD WILL HOLD IT: enough of it to judge, with the marked fragments intact.
 *
 * The spans come from the classifier (matchCommand), so the card marks what the RULE fired on rather than
 * re-running the patterns in a browser and marking whatever a second copy of them found.
 *
 * A HEAD-ONLY CUT COULD THROW AWAY THE ONE THING THE CARD IS ABOUT. A heredoc that writes a script and then
 * deletes a tree puts the `rm -rf` four hundred characters in, so "this command would delete files
 * recursively" arrived over four hundred characters in which nothing deletes anything, and the reader was
 * asked to take the title's word for it. So when the held class's fragments sit past the head, the budget is
 * split: `HEAD` characters of the beginning, which is what identifies the program, then a window around the
 * fragments themselves, with the skipped middle declared in place as `[… N characters not shown …]`. The two
 * segments are the excerpt, `spans` are rebased onto it, and `truncated` still says there is more.
 *
 * Fragments past the window are dropped rather than left dangling — the window is sized by what fits, and a
 * command with marks scattered over kilobytes cannot show all of them on a card. What it can promise is that
 * the FIRST flagged fragment is always on the card, under the title that named it, and that the transcript
 * beside the tool call has the whole program.
 *
 * ONLY THE HELD CLASS'S fragments. The title says which consequence stopped this ("would read credential
 * material"), so marking a second matched class's fragments beside it would point at text nobody is being asked
 * about, under a sentence that does not describe it. */
const programAsk = (program: string, subject: GateSubject, matches: readonly CommandMatch[], held: CommandClass): ProgramAsk => {
    const spans: readonly CommandSpan[] = matches.find((match) => match.commandClass === held)?.spans ?? [];
    const language = subject.language;
    if (program.length <= SHOWN) {
        return { text: program, language, truncated: false, spans: [...spans] };
    }
    // The whole mark already lands inside a plain head cut, so take one: an elision that skips nothing is
    // noise, and the beginning read in one piece is the most legible excerpt there is.
    const first = spans[0];
    if (first === undefined || first.end <= SHOWN) {
        return { text: program.slice(0, SHOWN), language, truncated: true, spans: spansWithin(spans, 0, SHOWN, 0) };
    }
    const from = first.start - LEAD;
    // The mark starts inside (or barely past) the head, and only its tail runs long: a head cut reaches it
    // already, so widening to two segments would elide the run-up to a mark it is showing.
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

/* THE ONE CLASS THE HARD RULE COVERS, if the command is in it. Undefined ⇒ nothing here is un-waivable and the
 * judge decides.
 *
 * Still one consult per class rather than a decide handed a list, which is what keeps "most restrictive wins"
 * observable at the consult site rather than buried inside the action. */
const hardRuled = (classes: readonly CommandClass[]): CommandClass | undefined =>
    classes.find((commandClass) => guard(commandRun, { commandClass }).effect !== "allow");

/* WHY A COMMAND CANNOT BE ASKED ABOUT, in the words the model reads back, or undefined when a card can be
 * raised. Both branches are properties of the TURN rather than of the policy, which is exactly why they are
 * decided here and not by the judge — the judge is told about the first (JudgeFacts.unattended) so that the
 * owner's policy can rule on an unattended turn directly, and only a verdict that still says `ask` reaches this.
 *
 * Each refusal tells the model not to retry, for one reason: a turn that works around a refusal it was just
 * given is the failure these sentences exist to prevent. */
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

/* WHAT HAPPENS WHEN THE JUDGE CANNOT RUN: nothing connected, every rung spent, every rung off-shape, the turn
 * aborted. It is a real state and it needs a stated posture rather than an accident.
 *
 * THE POSTURE: fall back to the hard rule, and allow everything else. That is deliberately the same answer the
 * old rulebook gave a workspace whose owner had never opened the settings, minus the false positives — a
 * sandbox whose quick-model chain is spent must not become a sandbox that refuses ordinary work, because the
 * commands reaching this point are overwhelmingly triage false positives and the container is still the
 * boundary. The hard rule keeps applying because it never depended on a model in the first place.
 *
 * The sentence says the judge did not run rather than inventing a reason, so a card raised on this path does not
 * read as a verdict somebody reached. */
const JUDGE_UNAVAILABLE = `The safety judge could not be reached, so this was decided by the standing rule alone.`;

export const createCommandGate = (options: CommandGateOptions): CommandGate => {
    /* WHAT AN ANSWERED CARD REMEMBERS FOR THE REST OF THIS TURN, keyed by the program text itself.
     *
     * KEYED BY THE PROGRAM, not by the class, and that is the change the judge made possible. The old grant was
     * per CommandClass, because a class was all the gate knew: saying yes to one recursive delete waved through
     * every recursive delete for the turn, including ones aimed somewhere else entirely. That was the most
     * generous thing a card could be made to mean, and it was generous because the alternative — asking again
     * about a command the judge would rule on identically — was a second interruption. It no longer is: the
     * judge is memoised below, so a repeated command is re-decided for free and only a genuinely different one
     * costs anything. So a yes now means yes to THIS, which is what the person clicking it thought it meant.
     *
     * The durable half of "always" is not here at all: it is `options.remember`, which appends the judge's
     * proposed line to the owner's policy, where they can read it, edit it and take it back. */
    const granted = new Set<string>();
    /* EVERY JUDGED PROGRAM'S VERDICT, for the life of the turn. What makes the per-call model cost bearable: a
     * build loop that runs the same flagged command eleven times pays for one judgment, and the ten repeats are
     * a map lookup. Keyed by program text alone because the policy is snapshotted per turn (see options.policy)
     * and the other facts either do not change within a turn or only ever get stricter — the taint bit is
     * one-way, so a command judged before a page was read is re-judged after it (see the key below).
     *
     * Promises rather than values, so two concurrent consults of the same program share one call rather than
     * racing two. */
    const judged = new Map<string, Promise<SafetyVerdict>>();
    /* The fact-check under `secrets.access`, bound once per turn. It reads the file a credential-shaped path
     * names and drops the class when there is demonstrably no credential in it — see guard/credential-files.ts
     * for what it will and will not answer, and the contract's CommandContext for why only a positive "no"
     * counts. Not cached across commands on purpose: a turn that writes a token into `.env` and then reads it
     * back must be judged on the file as it is at each consult, not as it was at the first. */
    const context: CommandContext = { holdsSecret: createCredentialOracle(options.cwd) };

    const record = (entry: Omit<SafetyLogEntry, "at">, at: number): void => {
        options.log?.({ at, ...entry });
    };

    /* ASK THE JUDGE, ONCE PER (TAINT STATE, PROGRAM). The taint source is in the key because it is the one fact
     * that changes mid-turn and only ever toward stricter: a command allowed before the turn fetched a page must
     * be asked again afterwards, or the memo would be laundering a pre-taint verdict into a tainted turn. */
    const askJudge = (program: string, facts: JudgeFacts): Promise<SafetyVerdict> => {
        // NUL as the separator, written as an escape so the file stays text: it is the one character neither a
        // taint source nor a shell command can contain, so no two distinct pairs can collide into one key.
        const key = `${facts.outsideSource ?? ``}\u0000${program}`;
        const existing = judged.get(key);
        if (existing !== undefined) {
            return existing;
        }
        // A rejection is not cached: a chain that was momentarily unreachable should be asked again rather than
        // condemning every later command in the turn to the unavailable path.
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
            // Matched rather than merely classified, so the fragments that fired are in hand if this ends on a
            // card. An allowed command drops them a line later and pays only the offsets the same walk collected.
            const matches = matchCommand(program, context);
            // TIER 1. Nothing matched ⇒ nothing to judge, and no model was spent: this is the overwhelming
            // majority of everything an agent runs, and it must stay free. Bound rather than length-checked so
            // the first match is in hand below without a fallback that could only ever mislabel a card.
            const first = matches[0];
            if (first === undefined) {
                return ALLOWED;
            }
            const classes = matches.map((match) => match.commandClass);
            const at = Date.now();
            const outsideSource = options.taint.source();
            /* TIER 1½, THE HARD RULE, applied before the judge is called and un-waivable by it. The class it
             * names is also what the card's title says, so the person is told which consequence stopped this
             * rather than being handed the judge's paraphrase of it. */
            const hard = hardRuled(classes);
            const facts: JudgeFacts = {
                consequences: classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]),
                unattended: options.unattended,
                language: subject.language,
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(outsideSource === undefined ? {} : { outsideSource }),
                ...(options.machine === undefined ? {} : { machine: options.machine }),
            };
            /* TIER 2. A judge that cannot run leaves the hard rule standing and lets everything else through —
             * see JUDGE_UNAVAILABLE for why that direction and not the other. */
            const verdict: SafetyVerdict = await askJudge(program, facts).catch(
                (): SafetyVerdict => ({ decision: hard === undefined ? "allow" : "ask", sentence: JUDGE_UNAVAILABLE }),
            );
            // The hard rule can only ever make a verdict stricter, never looser: an `allow` over a class nothing
            // recovers becomes an ask, and a `refuse` stays a refusal.
            const decision = hard !== undefined && verdict.decision === "allow" ? "ask" : verdict.decision;
            const entry = { program: excerptProgram(program), classes, decision, sentence: verdict.sentence };
            if (decision === "allow") {
                record({ ...entry, outcome: "allowed" }, at);
                return ALLOWED;
            }
            if (decision === "refuse") {
                record({ ...entry, outcome: "refused" }, at);
                return { allow: false, reason: `${verdict.sentence} Refused by your owner's safety policy. Do not retry.` };
            }
            // Already answered for this exact program earlier in the turn. Checked after the judge rather than
            // before, so the log still records what would have happened and the memo stays honest about it.
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
            /* The card carries the program AS A PROGRAM, with the fragments that fired marked. The class it
             * marks is the hard-ruled one when there is one, and otherwise the first triage matched: the title
             * names that same class, so the marks and the sentence above them are about one thing.
             *
             * `explain` is the judge's sentence and it is on the card from the moment it goes out. Nothing
             * races it in afterwards any more; the verdict had to exist before there was a card at all. */
            const marked = hard ?? first.commandClass;
            yield {
                kind: "permission",
                requestId: id,
                toolName: subject.toolName,
                title: `This ${subject.noun} would ${COMMAND_CLASS_LABELS[marked]}`,
                displayName: subject.displayName,
                program: programAsk(program, subject, matches, marked),
                /* `explain` and NOT `reason`. They are one sentence now: the judge's account of the command IS
                 * why the card exists, where the two used to be different things (a rule's name, plus an
                 * optional translation of the shell). Sending both would print the same words twice on one
                 * card, once as the lead and once as the muted subline. */
                explain: verdict.sentence,
                /* THE ALWAYS BUTTON IS AN EDIT TO THE POLICY, and its label is the line that would be written,
                 * so nobody accepts a rule they have not read. Offered only when the judge proposed a line AND
                 * there is somewhere to put it — the schema says to send `alwaysLabel` only when an always has
                 * something to remember, and a button that silently meant "just this turn" would be the card
                 * lying about what it did. */
                ...(verdict.policyLine !== undefined && options.remember !== undefined
                    ? { alwaysLabel: `Always: ${verdict.policyLine}` }
                    : {}),
            };
            const { reply, resolved } = await wait(options.signal);
            // Every parked card owes the stream its resolution frame: it is what freezes the card in a replayed
            // transcript, and the only honest account of how long the turn was parked.
            yield resolved;
            if (reply.decision === "deny") {
                options.answered?.(at, "declined", "refused");
                // A denial with feedback is a redirection and the turn takes it; a bare one is the user
                // stopping this command, so say that rather than inviting a way around it.
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
                // The write is not awaited and its failure is swallowed: the owner has answered, the command
                // should run, and a policy file that could not be written is not a reason to refuse it.
                void options.remember?.(verdict.policyLine).catch(() => undefined);
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
