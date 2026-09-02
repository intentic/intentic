import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent, AgentHarness, AgentProvider, AgentTurn, AskQuestion } from "@intentic/sandbox-contract";
import { capabilitiesOf, newConversationId, PROVIDERS } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { createRequest, resolveRequest } from "../agent/agent-requests.js";
import { steerTurn } from "../agent/agent-steering.js";
import { childSpawn } from "../guard/actions.js";
import { guard } from "../guard/guard.js";
import { conversationTaintSource, markConversationTaint } from "../guard/turn-taint.js";
import { noteChildWork } from "../agent/child-verification.js";
import { openSpawnedChild, noteSpawnedChild, settleSpawnedChild, type SubagentTurn } from "../agent/subagents.js";
import { startTurnRun, turnRunOf } from "../agent/turn-runs.js";
import { openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { credentialsTravel, placeFanOut } from "../runners/runner-scheduler.js";
import { runnerSummaries } from "../runners/runner.routes.js";

/* SPAWN, STEER AND ANSWER FULL AGENTS FROM INSIDE A TURN, on ANY connected provider — the daemon-side engine
 * behind every door the supervision surface has (the Claude loop's MCP tools, Cursor's custom tools, the
 * `agents` CLI's routes).
 *
 * THE CHILD IS AN ORDINARY CONVERSATION, and that one decision is most of this module. It runs through the same
 * detached pump every composer turn does (turn-runs.ts), so it is watchable from any window, stoppable with the
 * same /agent/stop, transcribed by the same record, isolated in a worktree of its own, and served by whichever
 * provider adapter its spec names — which is the entire point: the spawning turn's own runtime is irrelevant,
 * because the child rides the same adapter registry the composer does. A Claude turn spawns Cursor's Composer
 * with the same call a Cursor turn would spawn Codex with.
 *
 * WHAT THIS MODULE ITSELF OWNS is therefore only what a conversation does not: the parentage (which turn
 * started it, how deep the chain is), the budgets, the child's life reported onto the parent's roster
 * (agent/subagents.ts, the `spawned` kind) by direct call at each move, and the ESCALATION LADDER — what a
 * parent may do about a child that stopped:
 *
 *   · a child parked on a QUESTION is the parent's to answer (`answer`): a question is a request for
 *     information, the parent often holds it, and the child's card carries the same requestId the ordinary
 *     reply route resolves;
 *   · a child parked on CONSENT — a permission hold, a plan approval — is the OWNER's alone. A parent that
 *     could approve its child's held commands would be a model approving its own dangerous actions through a
 *     proxy, so `answer` refuses those by kind and says whose they are. This distinction is the security
 *     spine of the whole surface;
 *   · a WORKING child can be steered (`send`), where its runtime takes mid-turn input;
 *   · a SETTLED child can be sent a follow-up (`send`), which runs a new turn on the child's own conversation,
 *     resuming the session its last turn reported, so refinement costs a message rather than a fresh child.
 *
 * THE BUDGETS ARE THE OWNER'S EXISTING ONES (SandboxSettings.subagentsAtOnce / subagentsPerTurn /
 * subagentDepth), enforced here in the daemon rather than handed to a harness as env, because a spawned child
 * gets the spawn door too, and a cap a model is merely told about is a cap a runaway chain never reads. A
 * follow-up turn spends the lifetime budget like a spawn does: it is a turn, and turns are what the budget
 * meters. The ledgers are in-memory like the roster's records and die with the daemon, which loses nothing
 * that matters: a daemon death also ends every child turn the ledgers were counting.
 *
 * A CHILD OUTLIVES ITS PARENT'S TURN on purpose: the spawn answers the moment the child is running, and the
 * parent supervises through `wait` — or walks away and leaves the child to finish as a conversation in its
 * own right, landing its work under the workspace's ordinary posture. */

// How much of the child's closing text the spawn/wait surfaces carry inline. The full text is in the child's
// own transcript; this is the roster row's answer to "what did it conclude".
const REPORT_KEPT = 2_000;

export interface ChildSpawnSpec {
    readonly prompt: string;
    // One line for the roster row and the child conversation's title. Falls back to the prompt's head.
    readonly description?: string;
    readonly provider?: AgentProvider;
    readonly harness?: AgentHarness;
    readonly model?: string;
    readonly effort?: string;
    readonly account?: string;
    /* WHICH MACHINE THIS ONE RUNS ON, when the caller has an opinion: a runner's id, or "here" to pin it to
     * this sandbox. Absent is the ordinary case and the point of the feature, the fleet scheduler picks
     * (runners/runner-scheduler.ts), because nobody chooses a machine thirty times for one fan-out. */
    readonly on?: string;
}

export interface ChildParent {
    readonly conversationId: string;
    // The parent turn's tree as the daemon reaches it, the roster handle's cwd.
    readonly cwd: string;
}

export type ChildSpawnResult =
    // `id` is the child's conversation id, the roster record's id, and the wait tool's target, one string.
    { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

export type ChildActionResult = { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly message: string };

// The card a child is parked on right now, held so the parent can be handed the WHOLE question (a summary is
// enough to say "it stopped"; answering needs the options), and so `answer` can enforce the kind rule.
export interface PendingChildCard {
    readonly kind: "question" | "permission" | "plan";
    readonly requestId: string;
    readonly questions?: readonly AskQuestion[];
}

/* Everything the service knows about one child, keyed by its conversation id. `spec` and `sessionId` are what
 * a follow-up turn resumes with; `pending` is the escalation ladder's state. In-memory for the roster's
 * reason: every door must see the same ledger, and a daemon death ends the turns it was tracking. */
interface ChildRecord {
    readonly parent: string;
    readonly spec: ChildSpawnSpec;
    readonly depth: number;
    readonly cwd: string;
    sessionId: string | undefined;
    running: boolean;
    // When `running` was last set: the companion (invariant.ts) compares this ledger with the turn path's own
    // record of what is live, and needs to know a record's age to tell "not begun yet" from "never begun".
    startedAt: number;
    pending: PendingChildCard | undefined;
}

const kids = new Map<string, ChildRecord>();

/* Parentage depth and spend, per conversation. `depth` is keyed by the CHILD's conversation id (a conversation
 * absent here is depth 0, a person's own); `spent` by the PARENT's, counting the child TURNS it has started,
 * live and lifetime. Module singletons for the roster's reason: the tool handler, the tests and the routes
 * must see the same ledgers. */
const depths = new Map<string, number>();
const spent = new Map<string, { live: number; total: number }>();

/* WHICH CONVERSATIONS MAY REACH THE SUPERVISION SURFACE FROM OUTSIDE A TOOL CALL, the seam behind the `agents`
 * CLI (bin/agents → /children routes). The in-loop tools are gated at mount (turn-plan withholds them from a
 * persona without the delegate shelf and full agency); a CLI call arrives with no mount to gate, so the same
 * decision is recorded HERE, at plan time, as the ready-to-use supervisor itself: planTurn arms a conversation
 * whose persona qualifies, and the route uses exactly what was armed. Armed for the conversation's lifetime,
 * the life a backgrounded shell already has: `agents spawn` keeps working from a shell after the turn that
 * opened it ends. In-memory like the roster, and a daemon death disarms everything it kills. */
const armed = new Map<string, ChildSupervisor>();

/** Record, at plan time, that this conversation's shell may supervise children — the exact object a tool call would use. */
export const armSupervisor = (conversationId: string, supervisor: ChildSupervisor): void => {
    armed.set(conversationId, supervisor);
};

/** The armed supervisor for a conversation, or undefined for one no qualifying turn ever planned. */
export const supervisorFor = (conversationId: string): ChildSupervisor | undefined => armed.get(conversationId);

/* IS THIS CONVERSATION SOMEBODY'S CHILD? Read off the depth ledger above, which is written for every spawn and
 * is the authoritative record of parentage; the `sub-` prefix on the id is a convenience for people reading
 * cards, not a fact to branch on.
 *
 * Asked by anything that would otherwise START A TURN on a conversation of its own accord (agent/verify-nudge.ts).
 * A child's turn ends and its record settles the moment its report reaches the parent; a turn started after
 * that runs for nobody, reports to nothing, and spends the owner's allowance doing it. Whatever a child left
 * unproven is already said where it can be acted on: it rides back with the report itself
 * (child-verification.ts) and it lands on the spend ledger. */
export const isSpawnedChild = (conversationId: string): boolean => depths.has(conversationId);

/* Every child this daemon has a record of, for the companion (invariant.ts) that compares this ledger with the
 * turn path's record of what is live. Settled children stay on it, that is what a follow-up `send` resumes. */
export const childLedger = (): readonly {
    readonly conversationId: string;
    readonly parent: string;
    readonly running: boolean;
    readonly startedAt: number;
}[] => [...kids].map(([conversationId, kid]) => ({ conversationId, parent: kid.parent, running: kid.running, startedAt: kid.startedAt }));

// Tests drive the service through its real entry points, so they need a way back to empty between cases.
export const resetChildrenForTest = (): void => {
    kids.clear();
    depths.clear();
    spent.clear();
    armed.clear();
};

// The provider's display label for the roster row ("Cursor", "Codex"); an id the catalog does not name (an
// endpoint, an installed ACP agent) shows as itself, which is at least true.
const labelOf = (provider: AgentProvider): string => PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;

/* What the child is waiting on, when a card parks its turn: the card itself, kind and all. The parent's
 * `wait` returns `blocked` with the summary riding the record, and the full card (options included, for a
 * question) rides the tool's own answer via pendingQuestionOf — which is the difference between a parent that
 * can ANSWER and one that can only report. */
const pendingOf = (event: AgentEvent): { readonly card: PendingChildCard; readonly summary: string } | undefined => {
    if (event.kind === "question") {
        return {
            card: { kind: "question", requestId: event.requestId, questions: event.questions },
            summary: event.questions[0]?.question ?? "Waiting on a question.",
        };
    }
    if (event.kind === "permission") {
        return {
            card: { kind: "permission", requestId: event.requestId },
            summary: event.title ?? `Waiting on permission for ${event.toolName}.`,
        };
    }
    if (event.kind === "plan") {
        return { card: { kind: "plan", requestId: event.requestId }, summary: "Waiting for its plan to be approved." };
    }
    return undefined;
};

/** The question a blocked child is parked on, whole, for the wait surfaces to hand the parent. Undefined for a
 *  child parked on consent (whose card is the owner's, never a parent's) and for one not parked at all. */
export const pendingQuestionOf = (childId: string): PendingChildCard | undefined => {
    const pending = kids.get(childId)?.pending;
    return pending?.kind === "question" ? pending : undefined;
};

/* ONE CHILD TURN, pumped and reduced onto the roster — the shared engine under a spawn and a follow-up send.
 * Detached: the caller answers the moment the turn is running, and the pump folds even a thrown turn into an
 * error frame and a done. */
const runChildTurn = (
    services: Services,
    childId: string,
    parent: string,
    turn: AgentTurn & { conversationId: string },
    turnFn: TurnFn,
): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
    const opened = openTurnTranscript(services, turn);
    const run = startTurnRun((input, signal) => turnFn(services, input, signal), turn, {
        before: opened,
        transcript: (events, startedAt) => recordTurnTranscript(services, turn, events, startedAt),
    });
    if (run === undefined) {
        return { ok: false, message: "A turn is already running on that conversation." };
    }
    void (async () => {
        const kid = kids.get(childId);
        let bubble = "";
        let report = "";
        let toolUses = 0;
        let tokens = 0;
        let failure: string | undefined;
        try {
            for await (const { event } of run.follow(0)) {
                /* WHAT THIS CHILD PROVED, off its own normalized frames, which is what makes the verdict hold
                 * on a child running Codex, Cursor or Gemini rather than only where the Claude hooks reach
                 * (child-verification.ts). Its OWN delegations count too, deliberately: a child that handed
                 * the edit to a grandchild is still the agent whose report the parent will read, and the work
                 * landed in its worktree either way. Before the branches below, several of which `continue`. */
                noteChildWork(event, childId);
                if (event.kind === "session") {
                    if (kid !== undefined) {
                        kid.sessionId = event.sessionId;
                    }
                    continue;
                }
                if (event.kind === "delta" && event.parentToolUseId === undefined) {
                    bubble += event.text;
                    continue;
                }
                if (event.kind === "text_end" && event.parentToolUseId === undefined) {
                    // The LAST closed bubble is the report: a turn's closing text is its answer, and the head
                    // of everything it ever said is its greeting.
                    report = bubble.trim() === "" ? report : bubble;
                    bubble = "";
                    continue;
                }
                if (event.kind === "tool_call" && event.parentToolUseId === undefined) {
                    toolUses += 1;
                    noteSpawnedChild(childId, { toolUses, lastTool: event.name });
                    continue;
                }
                if (event.kind === "usage") {
                    tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
                    noteSpawnedChild(childId, { tokens });
                    continue;
                }
                const parked = pendingOf(event);
                if (parked !== undefined) {
                    if (kid !== undefined) {
                        kid.pending = parked.card;
                    }
                    noteSpawnedChild(childId, { status: "blocked", summary: parked.summary });
                    continue;
                }
                if (event.kind === "resolved") {
                    if (kid !== undefined) {
                        kid.pending = undefined;
                    }
                    noteSpawnedChild(childId, { status: "running" });
                    continue;
                }
                if (event.kind === "error") {
                    failure = event.message;
                }
            }
        } catch (error) {
            failure = errorMessage(error);
        } finally {
            const closing = (bubble.trim() !== "" ? bubble : report).trim().slice(0, REPORT_KEPT);
            if (kid !== undefined) {
                kid.running = false;
                kid.pending = undefined;
            }
            settleSpawnedChild(childId, {
                failed: failure !== undefined,
                report: closing,
                ...(failure !== undefined ? { error: failure } : {}),
            });
            const now = spent.get(parent);
            if (now !== undefined) {
                spent.set(parent, { live: Math.max(0, now.live - 1), total: now.total });
            }
        }
    })();
    return { ok: true };
};

/* THE OWNER'S RULE AND THE TAINT FLOOR, consulted before every supervisor mutation — spawn, follow-up send,
 * steer, answer — because each one is the parent's judgment reaching a child that spends the owner's
 * accounts, and each door (harness tool, Cursor tool, CLI route) lands here.
 *
 * A HOLD ASKS, AND ONLY REFUSES WHERE THERE IS NOBODY TO ASK. It used to refuse unconditionally, on the
 * grounds that a call may arrive from a shell whose turn has already ended with nobody to raise a card to.
 * That is true of SOME doors and was applied to all of them, which made the commonest case by far — a live,
 * watched turn calling the supervision tool, with the owner sitting right there — indistinguishable from the
 * detached one: the model got a sentence telling it to go and ask in chat, the owner got nothing at all, and
 * the only way through was for the human to notice the refusal in a transcript and write an action rule.
 *
 * `commandRun` has always drawn this line properly for shell commands (a hold parks on a card; an unattended
 * turn gets the refusal and is told not to retry) and the wallet's payment offer does the same from a ROUTE,
 * which is the shape this needed: `turnRunOf` is what answers "is there a live stream to raise a card in",
 * and its absence is the real unattended case rather than a guess about which door was used. */
const admitSupervision = async (
    services: Services,
    parent: string,
    provider: string,
    move: SupervisionMove,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    const settings = await services.sandboxSettings.get();
    const outsideSource = conversationTaintSource(parent);
    const verdict = guard(childSpawn, {
        provider,
        rules: settings.actionRules,
        ...(outsideSource !== undefined ? { outsideSource } : {}),
    });
    if (verdict.effect === "deny") {
        return { ok: false, message: `Refused: ${verdict.reason}.` };
    }
    if (verdict.effect === "hold") {
        return askOwner(services, parent, provider, move, verdict.reason);
    }
    return { ok: true };
};

// Which supervisor move is being held, so the card names what it would actually do. A card reading "start an
// agent" over a call that only answers a question the child already asked is a card that gets denied for the
// wrong reason.
type SupervisionMove = "spawn" | "send" | "answer";
const MOVE_TITLE: Readonly<Record<SupervisionMove, string>> = {
    spawn: "Start a child agent",
    send: "Send this to a child agent",
    answer: "Answer a child agent",
};
const MOVE_BUTTON: Readonly<Record<SupervisionMove, string>> = { spawn: "Start it", send: "Send it", answer: "Answer it" };

/* How long a held supervisor call waits for an answer before giving up. The payment offer's own window, and
 * for its reason: long enough that somebody who stepped away can still come back to it, short enough that a
 * dead client does not hold a tool call open for the rest of the turn. */
const SUPERVISION_DEADLINE_MS = 10 * 60_000;

/* Raise the card and wait, or say why it could not be raised.
 *
 * THE REFUSALS ARE THREE DIFFERENT THINGS and are worded as three, because the model's next move differs and
 * because putting words in the owner's mouth is the specific failure to avoid: nobody to ask, asked and
 * nobody answered, asked and told no. Only the last one is the owner declining. */
const askOwner = async (
    services: Services,
    parent: string,
    provider: string,
    move: SupervisionMove,
    reason: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    const run = turnRunOf(parent);
    if (run === undefined || run.done) {
        // The genuinely unattended door: a detached `agents` shell, or a turn that has already ended. There is
        // no stream to draw a card in, so this is where the old sentence still belongs.
        return {
            ok: false,
            message:
                `Held for the owner: ${reason}. This call arrived outside a live turn, so there was nowhere to ask them. ` +
                `Ask in chat; they can also set the agents.spawn action rule.`,
        };
    }
    const { id, wait } = createRequest(
        "permission",
        { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
        parent,
    );
    /* No `alwaysLabel`: the schema says to send one only when an "always" has something to remember, and
     * nothing here persists a grant. Offering a button whose answer is silently downgraded to "once" would be
     * the card lying about what it did. */
    const raised: AgentEvent = {
        kind: "permission",
        requestId: id,
        toolName: "agents.spawn",
        title: `${MOVE_TITLE[move]} on ${provider}?`,
        displayName: MOVE_BUTTON[move],
        reason,
    };
    run.push(raised);
    services.agents.observe(parent, raised);
    const { reply, resolved } = await wait(AbortSignal.timeout(SUPERVISION_DEADLINE_MS));
    // Every parked card owes the stream its resolution frame: it is what stops a client rendering the card as
    // live, and the only honest account of how long the call was parked.
    run.push(resolved);
    services.agents.observe(parent, resolved);
    if (reply.decision === "deny") {
        // Told apart the payment offer's way: a resolved frame carrying no reply is the deadline or a dead
        // client, and reading that as "declined" would put a refusal in the owner's mouth they never gave.
        return resolved.reply === undefined
            ? {
                  ok: false,
                  message: `Nobody answered the request to ${move === "spawn" ? "start" : move} a child agent, so it did not run. Carry on without it and say what you left undone.`,
              }
            : {
                  ok: false,
                  message: `The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
              };
    }
    return { ok: true };
};

/* THE FLOOR THAT COMPOSES DOWNWARD: a child on a runtime whose rulebook axis is "none" runs beyond every gate
 * this daemon has (no consult, no hold, no taint marking of its own), so the PARENT that started it and will
 * read its report has taken in content no policy could see. The parent's own turn bit engages, exactly as it
 * does for a fetched page — the safe direction, and the one the axis's own documentation promises. */
const composeRuntimeFloor = (parent: string, provider: AgentProvider, harness: AgentHarness): void => {
    if (capabilitiesOf(provider, harness).rulebook === "none") {
        markConversationTaint(parent, `agent:${provider}`);
    }
};

/* The one budget check both doors share: may this parent put one more child turn in flight?
 *
 * READS AND RESERVES IN ONE SYNCHRONOUS STEP, which is the whole point of the shape. This used to hand its
 * snapshot of the ledger back to the caller, which wrote the increment much later, several statements and an
 * `await` past the check. Two spawns arriving together — two backgrounded `agents spawn` shells, two POSTs to
 * /children/spawn, two tool calls in one assistant block — both read `{live: 0}`, both passed a ceiling of
 * one, and both then wrote `{live: 1}`. So the cap admitted N children instead of one and the lifetime counter
 * recorded a single turn for all of them, which is the runaway this budget exists to stop, counted by a ledger
 * that could not see two of anything. Reading and writing with no await between them is what makes it a cap.
 *
 * `release` refunds a reservation whose turn never started. A turn that DID start gives its live seat back in
 * runChildTurn's finally instead; `total` is a lifetime count, so only a never-started turn ever refunds it. */
const admitChildTurn = async (
    services: Services,
    parent: string,
): Promise<{ readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly message: string }> => {
    const settings = await services.sandboxSettings.get();
    const ledger = spent.get(parent) ?? { live: 0, total: 0 };
    if (ledger.live >= settings.subagentsAtOnce) {
        return { ok: false, message: `${ledger.live} children are already running: wait for one before starting another.` };
    }
    if (ledger.total >= settings.subagentsPerTurn) {
        return { ok: false, message: `This conversation has started ${ledger.total} child turns, its lifetime budget.` };
    }
    spent.set(parent, { live: ledger.live + 1, total: ledger.total + 1 });
    return {
        ok: true,
        release: (): void => {
            const now = spent.get(parent);
            if (now !== undefined) {
                spent.set(parent, { live: Math.max(0, now.live - 1), total: Math.max(0, now.total - 1) });
            }
        },
    };
};

/** Start a child agent and return the moment it is running. Refusals are ordinary states (a budget met, a
 *  depth exhausted), worded for the model that asked; a provider refusal (nothing connected) arrives later,
 *  as the child's own failure, exactly as it would arrive to a person at the composer. */
export const spawnChild = async (services: Services, parent: ChildParent, spec: ChildSpawnSpec, turnFn: TurnFn): Promise<ChildSpawnResult> => {
    const settings = await services.sandboxSettings.get();
    const depth = (depths.get(parent.conversationId) ?? 0) + 1;
    if (depth > settings.subagentDepth) {
        return { ok: false, message: `Spawn depth ${settings.subagentDepth} reached: this agent is itself a spawned child and may not go deeper.` };
    }
    const provider = spec.provider ?? "claude";
    const harness = spec.harness ?? "native";
    const allowed = await admitSupervision(services, parent.conversationId, provider, "spawn");
    if (!allowed.ok) {
        return allowed;
    }
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    /* THE SEAT IS CLAIMED, so from here every exit has to either hand it to a running turn or give it back.
     * A turn that starts gives it back in runChildTurn's finally; anything else refunds below. The `finally` is
     * what covers the paths nobody wrote deliberately: the reservation is now taken BEFORE this work rather
     * than written after it (which is what made the cap atomic), so a throw in here would strand it, and a
     * stranded live seat is permanent — it lowers `subagentsAtOnce` by one for the life of the conversation,
     * and once enough accumulate the parent is refused forever over children that do not exist. */
    let handedOff = false;
    try {
        composeRuntimeFloor(parent.conversationId, provider, harness);
        /* WHERE THIS CHILD RUNS. The whole reason a person connects a second machine is that work like this
         * spreads onto it without being asked to; so a spawn with no stated preference is placed by the
         * scheduler, and one that named a machine gets it (or this sandbox, if that machine is not usable
         * right now, which beats refusing work over a laptop that went to sleep). */
        const placement =
            spec.on === "here"
                ? undefined
                : placeFanOut(
                      await runnerSummaries(services),
                      { inFlight: services.agents.inFlightByRunner() },
                      {
                          ...(spec.on !== undefined ? { asked: spec.on } : {}),
                          // A child on a runtime whose credential cannot travel stays here unless somebody names a
                          // machine themselves (credentialsTravel says which, and why).
                          travels: credentialsTravel(provider, harness),
                      },
                  ).runner;
        const id = `sub-${newConversationId()}`;
        const description = (spec.description ?? spec.prompt).replaceAll(/\s+/gu, " ").trim().slice(0, 200);
        const turn: AgentTurn & { conversationId: string } = {
            prompt: spec.prompt,
            conversationId: id,
            title: description.slice(0, 80),
            // A worktree of its own, so parallel children (and the parent) never edit under each other. Landing
            // keeps the workspace's ordinary posture: a child's finished work merges the way any turn's does.
            isolated: true,
            ...(placement !== undefined ? { placement: { kind: "runner" as const, id: placement } } : {}),
            // Nobody is at a composer. This is what the flag means, and it also sets the safe persona floor: an
            // unattended turn with no named persona speaks for no outside account.
            unattended: true,
            agent: provider,
            harness,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
            ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
            ...(spec.account !== undefined ? { account: spec.account } : {}),
        };
        kids.set(id, {
            parent: parent.conversationId,
            spec: { ...spec, provider, harness },
            depth,
            cwd: parent.cwd,
            sessionId: undefined,
            running: true,
            startedAt: Date.now(),
            pending: undefined,
        });
        /* The roster handle: the PARENT's conversation, which is what the record files under and what the wait
         * tool matches on. The session/subagentsDir halves are the SDK children's concern and stay empty here. */
        const handle: SubagentTurn = { conversationId: parent.conversationId, cwd: parent.cwd, sessionId: undefined, subagentsDir: undefined };
        openSpawnedChild(handle, {
            id,
            description,
            agentType: labelOf(provider),
            provider,
            harness,
            spawnDepth: depth,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
        });
        const started = runChildTurn(services, id, parent.conversationId, turn, turnFn);
        if (!started.ok) {
            kids.delete(id);
            settleSpawnedChild(id, { failed: true, report: "", error: started.message });
            // A fresh id colliding with a live run should be impossible; saying so beats pretending a child exists.
            return { ok: false, message: "The child's conversation could not be started." };
        }
        depths.set(id, depth);
        handedOff = true;
        return { ok: true, id };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

/** Steer a working child, or send a settled one a follow-up turn on its own conversation, resuming the
 *  session its last turn reported. Only the parent that started a child may reach it. */
export const sendToChild = async (
    services: Services,
    parent: ChildParent,
    childId: string,
    message: string,
    turnFn: TurnFn,
): Promise<ChildActionResult> => {
    const kid = kids.get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const allowed = await admitSupervision(services, parent.conversationId, kid.spec.provider ?? "claude", "send");
    if (!allowed.ok) {
        return allowed;
    }
    composeRuntimeFloor(parent.conversationId, kid.spec.provider ?? "claude", kid.spec.harness ?? "native");
    if (kid.running) {
        /* Mid-turn, the only door is the runtime's own steering seam, the same one /agent/steer uses. A
         * runtime without it cannot take words mid-turn, and pretending otherwise (queueing them somewhere
         * the model never reads) is worse than saying so. */
        return steerTurn(childId, message)
            ? { ok: true, note: "Steered: the message lands between its tool calls." }
            : { ok: false, message: "It is mid-turn on a runtime that takes no mid-turn input: wait for it to finish, then send again." };
    }
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    // The seat is claimed: same handoff-or-refund rule as spawnChild, and the `finally` covers the same
    // unwritten path — a throw between the claim and the running turn would strand it permanently.
    let handedOff = false;
    try {
        const spec = kid.spec;
        const turn: AgentTurn & { conversationId: string } = {
            prompt: message,
            conversationId: childId,
            isolated: true,
            unattended: true,
            ...(spec.provider !== undefined ? { agent: spec.provider } : {}),
            ...(spec.harness !== undefined ? { harness: spec.harness } : {}),
            ...(spec.model !== undefined ? { model: spec.model } : {}),
            ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
            ...(spec.account !== undefined ? { account: spec.account } : {}),
            // The session its last turn reported, so the follow-up continues the child's own context. Absent (a
            // turn that never reported one), the daemon seeds from the conversation's record instead, the
            // ordinary reopened-conversation path.
            ...(kid.sessionId !== undefined ? { sessionId: kid.sessionId } : {}),
        };
        // Reopen the roster record: same id, fresh life, so the parent's wait and the area both see it working.
        const handle: SubagentTurn = { conversationId: parent.conversationId, cwd: kid.cwd, sessionId: undefined, subagentsDir: undefined };
        openSpawnedChild(handle, {
            id: childId,
            description: message.replaceAll(/\s+/gu, " ").trim().slice(0, 200),
            agentType: labelOf(spec.provider ?? "claude"),
            provider: spec.provider ?? "claude",
            harness: spec.harness ?? "native",
            spawnDepth: kid.depth,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
        });
        kid.running = true;
        kid.startedAt = Date.now();
        const started = runChildTurn(services, childId, parent.conversationId, turn, turnFn);
        if (!started.ok) {
            kid.running = false;
            settleSpawnedChild(childId, { failed: true, report: "", error: started.message });
            return started;
        }
        handedOff = true;
        return { ok: true, note: "Sent: the child is running a follow-up turn. Supervise it with wait." };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

/** Settle a child's QUESTION with the parent's picks — and only a question. A permission hold or a plan
 *  approval is the owner's consent gate: a parent that could approve its child's held commands would be a
 *  model approving its own dangerous actions through a proxy, so those refuse by kind, always. */
export const answerChild = async (
    services: Services,
    parent: ChildParent,
    childId: string,
    answers: Record<string, string[]>,
): Promise<ChildActionResult> => {
    const kid = kids.get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const allowed = await admitSupervision(services, parent.conversationId, kid.spec.provider ?? "claude", "answer");
    if (!allowed.ok) {
        return allowed;
    }
    const pending = kid.pending;
    if (pending === undefined) {
        return { ok: false, message: "It is not waiting on anything right now." };
    }
    if (pending.kind !== "question") {
        return {
            ok: false,
            message:
                pending.kind === "permission"
                    ? "It is waiting on a PERMISSION, which is the owner's consent to give, not a parent's. The owner answers it in their chat."
                    : "It is waiting on PLAN approval, which is the owner's consent to give, not a parent's. The owner answers it in their chat.",
        };
    }
    if (!resolveRequest({ kind: "question", requestId: pending.requestId, answers })) {
        return { ok: false, message: "That question already settled." };
    }
    return { ok: true, note: "Answered: the child carries on with your picks." };
};

/* EVERYTHING A PARENT MAY DO ABOUT ITS CHILDREN, as one object — what the tool mounts consume and what
 * planTurn arms for the CLI's routes, so every door runs exactly the same decisions. Built by the route that
 * owns the turn generator (agent.routes.ts), the only module that can hand streamAgent down without a cycle. */
export interface ChildSupervisor {
    readonly spawn: (spec: ChildSpawnSpec) => Promise<ChildSpawnResult>;
    readonly send: (childId: string, message: string) => Promise<ChildActionResult>;
    readonly answer: (childId: string, answers: Record<string, string[]>) => Promise<ChildActionResult>;
    readonly pendingQuestion: (childId: string) => PendingChildCard | undefined;
}

export const childSupervisor = (services: Services, parent: ChildParent, turnFn: TurnFn): ChildSupervisor => ({
    spawn: (spec) => spawnChild(services, parent, spec, turnFn),
    send: (childId, message) => sendToChild(services, parent, childId, message, turnFn),
    answer: (childId, answers) => answerChild(services, parent, childId, answers),
    pendingQuestion: (childId) => (kids.get(childId)?.parent === parent.conversationId ? pendingQuestionOf(childId) : undefined),
});
