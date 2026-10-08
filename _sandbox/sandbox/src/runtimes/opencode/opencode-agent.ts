import { basename } from "node:path";
import type { OpenCodeClient, OpenCodeEvent, PermissionRule } from "@opencode/client";
import { type AgentEvent, OPENCODE } from "@intentic/sandbox-contract";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import { loadAttachments } from "../../agent/prompt/attachment-images.js";
import { type EmulatedPlan, EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { DEFAULT_TURN_TIMEOUTS, EXPIRED, type TurnTimeouts, type TurnWatchdog, turnWatchdog } from "../decorators/turn-watchdog.js";
import { isRateLimited, vendorFailureFrame, type VendorRule } from "../decorators/vendor-errors.js";
import { isContextOverflowText } from "../../agent/providers/failure-sentences.js";
import { modelUnavailableFrame } from "../../agent/run/error-frames.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { planPhaseOf, type TurnCapture, usageTotals } from "../decorators/vendor-events.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { opt } from "../../opt.js";
import { isChatModel, OPENCODE_XAI_PROVIDER, parseModelSuggestions } from "./xai-models.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { openCodeBackendLabel, type OpenCodeLease, type OpenCodeService } from "./opencode.js";
import type { SessionJudge, SessionJudges } from "./opencode-permissions.js";
import { isToolEvent, sessionOf, stepTokens, toolCards, type TurnView } from "./opencode-frames.js";
import { mcpServersOf, mcpToolNameOf, openCodeMounts, type OpenCodeMounts, sessionToolRules } from "./opencode-mcp.js";
import { openCodeSubagents } from "./opencode-subagents.js";

// The OpenCode loop Grok and Gemini both run on: AgentRequest in, AgentEvent frames out, over one shared `opencode serve`.

// A picture as OpenCode's prompt takes it: a data URL, since the server is reached over HTTP and reads no path of ours.
export interface PromptFile {
    readonly uri: string;
    readonly name?: string;
}

// One OpenCode turn: the runner creates or resumes its session and yields its events; injected so tests drive a fake stream.
export interface OpenCodeTurn {
    readonly prompt: string;
    readonly sessionId?: string;
    readonly cwd: string;
    readonly model?: string;
    // OpenCode's provider id to drive this turn on; absent means xAI. Per-turn: one shared opencode serve carries both
    // providers.
    readonly provider?: string;
    // The built-in OpenCode agent: "plan" is read-only (proposes), "build" executes.
    readonly agent: "plan" | "build";
    // Command-rulebook gate for this turn, registered against the session id once it exists; absent means every
    // permission gets the standing yes.
    readonly gate?: CommandGuard;
    // The turn's MCP servers, mounted for the turn under its conversation's own names (opencode-mcp.ts); absent mounts
    // none, and the turn still sees no other conversation's.
    readonly mounts?: OpenCodeMounts;
    // Standing instructions (a sealed request's system prompt), set as the session's own instruction entry, which
    // OpenCode adds to its system prompt rather than replacing it; set again by every message.
    readonly system?: string;
    // Images already read off disk, sent as native parts rather than named as paths in the prompt; read in the adapter
    // so an unreadable one falls back to a prompt note.
    readonly images?: readonly PromptFile[];
    // A sealed request (agent-request.ts `policy.sealed`): every tool denied, and its session deleted once it answered,
    // since nothing resumes it.
    readonly sealed?: true;
    readonly signal: AbortSignal;
}

// Every tool denied, OpenCode's own included: the wildcard keeps this from tracking OpenCode's tool names in step.
const NO_TOOLS: readonly PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];

// The session's own instruction entry the turn's standing instructions ride in; one key, replaced by every message.
const INSTRUCTIONS_KEY = "intentic";

// A frame the daemon raised for the turn itself (a permission card, then its resolution), carried in order with the
// session's events; OpenCode sends no event of this type.
export interface RaisedFrame {
    readonly type: "intentic.frame";
    readonly frame: AgentEvent;
}
// The session the turn runs on, said before any of its events; `created` when this turn made it.
export interface TurnSession {
    readonly type: "intentic.session";
    readonly sessionId: string;
    readonly created: boolean;
}
export type OpenCodeTurnEvent = OpenCodeEvent | RaisedFrame | TurnSession;
export type OpenCodeRunner = (turn: OpenCodeTurn) => AsyncIterable<OpenCodeTurnEvent>;

// How long a turn whose own work has ended waits for OpenCode to pick up what a background shell or subagent left it
// (OpenCode wakes the session with their result as soon as they end, within milliseconds).
const FOLLOW_UP_MS = 5_000;

// Inactivity is not a hang while only a background shell runs: its output reaches the turn when it ends, not as it goes.
const BACKGROUND_WAIT = Number.MAX_SAFE_INTEGER / 2;

// What a read answers once the follow-up wait passed with nothing new.
const SETTLED: unique symbol = Symbol("settled");

// Everything one turn reads, in arrival order: its session family's events, and the cards its judge raises.
const turnQueue = () => {
    const items: (OpenCodeEvent | RaisedFrame)[] = [];
    let lost: Error | undefined;
    let wake: (() => void) | undefined;
    const ping = (): void => {
        wake?.();
        wake = undefined;
    };
    return {
        push: (item: OpenCodeEvent | RaisedFrame): void => {
            items.push(item);
            ping();
        },
        lose: (reason: Error): void => {
            lost ??= reason;
            ping();
        },
        // The next item, or why there will be none: the stream lost, the watchdog's deadline, or the follow-up wait over.
        next: async (clock: TurnWatchdog, followUpUntil: number | undefined): Promise<OpenCodeEvent | RaisedFrame | Error | typeof EXPIRED | typeof SETTLED> => {
            for (;;) {
                const item = items.shift();
                if (item !== undefined) {
                    return item;
                }
                if (lost !== undefined) {
                    return lost;
                }
                if (clock.remaining() <= 0) {
                    return EXPIRED;
                }
                if (followUpUntil !== undefined && Date.now() >= followUpUntil) {
                    return SETTLED;
                }
                let timer: NodeJS.Timeout | undefined;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    timer = setTimeout(resolve, Math.max(1, Math.min(clock.remaining(followUpUntil), 60_000)));
                });
                clearTimeout(timer);
            }
        },
    };
};

// A turn's session and the subagent sessions its subagent calls open beneath it, each naming its parent: a subagent's
// work reaches the turn instead of being dropped as another session's, keeps the turn's watchdog fed, and answers to the
// rules its parent does, since its asks carry its own session id. Also the background shells the family started, whose
// endings are the turn's business though their events name no session.
export const sessionFamily = (root: string, judge: SessionJudge | undefined, judges: SessionJudges) => {
    const members = new Set<string>();
    const shells = new Set<string>();
    const join = (session: string): void => {
        members.add(session);
        if (judge !== undefined) {
            judges.register(session, judge);
        }
    };
    join(root);
    return {
        // Whose an event is: the turn's own session's, one of its subagents', one of its background shells', or no
        // concern of this turn's.
        whose: (event: OpenCodeEvent): "own" | "subagent" | "shell" | undefined => {
            if (event.type === "shell.exited" || event.type === "shell.deleted") {
                const id = event.type === "shell.exited" ? event.data.id : event.data.id;
                return shells.delete(id) ? "shell" : undefined;
            }
            if (event.type === "session.created" && event.data.parentID !== undefined && members.has(event.data.parentID)) {
                join(event.data.sessionID);
            }
            const session = sessionOf(event);
            if (session === undefined || !members.has(session)) {
                return undefined;
            }
            // A shell the model sent to the background: its id rides the call's progress.
            if (event.type === "session.tool.progress" && typeof event.data.metadata["shellID"] === "string") {
                shells.add(event.data.metadata["shellID"]);
            }
            return session === root ? "own" : "subagent";
        },
        // Background shells still running.
        shells: (): ReadonlySet<string> => shells,
        // The judges die with their phase; a later permission belongs to no session judging it and gets the standing yes
        // (opencode-permissions.ts answerPermission).
        release: (): void => {
            for (const member of members) {
                judges.release(member);
            }
        },
    };
};

const interrupt = async (c: OpenCodeClient, sessionId: string): Promise<void> => {
    // allow(silent-catch): a refused interrupt leaves the session ending on its own events or the watchdog
    await c.session.interrupt({ sessionID: sessionId }).catch(() => {});
};

// xAI's named alternatives in a model-not-found rejection, chat models only; none for any other failure.
const modelSuggestions = (message: string): string[] => (MODEL_INVALID.test(message) ? parseModelSuggestions(message).filter(isChatModel) : []);

// A structured error's whole text: its sentence and, where the provider answered, the body it answered with, which is
// where xAI names its valid models.
type StructuredError = { readonly type: string; readonly message: string; readonly status?: number; readonly response?: { readonly body: string } };
const errorDetail = (error: StructuredError): string => (error.response === undefined ? error.message : `${error.message} ${error.response.body}`);

const EXECUTION_ENDS: ReadonlySet<string> = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

// Reads one turn's session family until its work is done. The turn's own session ends each execution with one of three
// events; a success is the end unless something the turn started in the background is still to report, in which case
// OpenCode wakes the session again when it does, and the turn waits for that execution too. The setup/cleanup owner
// keeps its runtime leased throughout.
async function* consumeTurn({
    turn,
    sessionId,
    queue,
    clock,
    family,
    heal,
    interruptSession,
}: {
    readonly turn: OpenCodeTurn;
    readonly sessionId: string;
    readonly queue: ReturnType<typeof turnQueue>;
    readonly clock: TurnWatchdog;
    readonly family: ReturnType<typeof sessionFamily>;
    // Re-prompts on one of xAI's suggested models after a rejection naming them; undefined once spent or never offered.
    heal: ((suggestions: string[]) => Promise<void>) | undefined;
    readonly interruptSession: () => Promise<void>;
}): AsyncGenerator<OpenCodeTurnEvent> {
    const label = openCodeBackendLabel(turn.provider ?? OPENCODE_XAI_PROVIDER);
    const running = new Set<string>();
    // Whether the turn's own session's latest execution ended well; the turn is done once nothing else is pending.
    let ownEnded = false;
    let followUpUntil: number | undefined;
    for (;;) {
        const item = await queue.next(clock, followUpUntil);
        if (item === EXPIRED) {
            await interruptSession();
            throw new Error(`${label} turn timed out waiting for OpenCode: ${clock.expiry()}.`);
        }
        if (item === SETTLED) {
            return;
        }
        if (item instanceof Error) {
            // The server's stream ended, so nothing will say this turn ended: only this turn's own stop explains that.
            if (turn.signal.aborted) {
                return;
            }
            throw new Error(`${label} stopped sending events before the turn ended.`);
        }
        // A card the judge raised goes out as it came; it is the daemon's own doing, not OpenCode's activity.
        if (item.type === "intentic.frame") {
            yield item;
            continue;
        }
        clock.touch();
        const session = sessionOf(item);
        if (item.type === "session.execution.started" && session !== undefined) {
            running.add(session);
            followUpUntil = undefined;
            if (session === sessionId) {
                ownEnded = false;
            }
        } else if (EXECUTION_ENDS.has(item.type) && session !== undefined) {
            running.delete(session);
        }
        // A background shell or subagent that ended after the turn's own work did is what the session is woken with.
        const backgroundEnded = item.type === "shell.exited" || item.type === "shell.deleted" || (session !== sessionId && EXECUTION_ENDS.has(item.type));
        if (backgroundEnded && ownEnded) {
            followUpUntil = Date.now() + FOLLOW_UP_MS;
        }
        if (session === sessionId) {
            // Move inactivity past a retry's next attempt, still bounded by the hard turn cap.
            if (item.type === "session.retry.scheduled") {
                clock.extendPast(item.data.at);
            }
            if (item.type === "session.execution.failed" && heal !== undefined) {
                const suggestions = modelSuggestions(errorDetail(item.data.error));
                if (suggestions[0] !== undefined) {
                    const healing = heal;
                    heal = undefined;
                    await healing(suggestions);
                    continue;
                }
            }
            if (item.type === "session.execution.interrupted" && !turn.signal.aborted) {
                throw new Error(`OpenCode stopped the ${label} turn (${item.data.reason}).`);
            }
            if (item.type === "session.execution.succeeded") {
                ownEnded = true;
            }
        }
        if (item.type !== "shell.exited" && item.type !== "shell.deleted") {
            yield item;
        }
        if (session === sessionId && (item.type === "session.execution.failed" || item.type === "session.execution.interrupted")) {
            return;
        }
        if (ownEnded && running.size === 0) {
            if (family.shells().size > 0) {
                clock.extendPast(BACKGROUND_WAIT);
            } else if (followUpUntil === undefined) {
                return;
            }
        }
    }
}

// The session a turn runs on: the one it resumes, set up for this message, else a new one, named on creation so
// OpenCode skips auto-titling (an extra model call per unnamed session).
const sessionFor = async (c: OpenCodeClient, turn: OpenCodeTurn, rules: readonly PermissionRule[]): Promise<{ id: string; created: boolean }> => {
    const model = turn.model === undefined || turn.model === "" ? undefined : { providerID: turn.provider ?? OPENCODE_XAI_PROVIDER, id: turn.model };
    if (turn.sessionId === undefined) {
        const created = await c.session.create({
            location: { directory: turn.cwd },
            title: "intentic conversation",
            agent: turn.agent,
            ...opt("model", model),
            permissions: [...rules],
        });
        return { id: created.id, created: true };
    }
    const sessionID = turn.sessionId;
    // A session keeps its rules, agent and model; each message sets the ones it runs with.
    await c.session.update({ sessionID, permissions: [...rules] });
    await c.session.switchAgent({ sessionID, agent: turn.agent });
    if (model !== undefined) {
        await c.session.switchModel({ sessionID, model });
    }
    return { id: sessionID, created: false };
};

// Sets or clears the session's standing instructions for this message.
const instruct = async (c: OpenCodeClient, sessionID: string, turn: OpenCodeTurn, created: boolean): Promise<void> => {
    if (turn.system !== undefined) {
        await c.session.instructions.entry.put({ sessionID, key: INSTRUCTIONS_KEY, value: turn.system });
    } else if (!created) {
        // allow(silent-catch): a session that never had the entry has nothing to clear
        await c.session.instructions.entry.remove({ sessionID, key: INSTRUCTIONS_KEY }).catch(() => {});
    }
};

// Runs on a leased client; even setup before the session has a judge belongs to this turn's server lifetime.
async function* runOpenCodeTurn(openCode: OpenCodeService, lease: OpenCodeLease, turn: OpenCodeTurn, timeouts: TurnTimeouts): AsyncGenerator<OpenCodeTurnEvent> {
    const c = lease.client;
    let family: ReturnType<typeof sessionFamily> | undefined;
    let stopListening = (): void => {};
    let unmount = async (): Promise<void> => {};
    let sealedSession: string | undefined;
    // The interrupt a Stop sent; the turn's judges stay in place until OpenCode has taken it, since an ask from a session
    // nobody judges is answered with the standing yes.
    let stopping: Promise<void> | undefined;
    try {
        const mounts = turn.mounts ?? openCodeMounts(undefined, []);
        const session = await sessionFor(c, turn, turn.sealed === true ? NO_TOOLS : sessionToolRules(mounts));
        const sessionId = session.id;
        sealedSession = turn.sealed === true ? sessionId : undefined;
        const queue = turnQueue();
        // whenAborted also handles a signal aborted before the session id existed. The queue is woken too: a turn waiting
        // on a background shell has no execution for OpenCode to say it interrupted, so nothing else would end the wait.
        whenAborted(turn.signal, () => {
            stopping = interrupt(c, sessionId);
            queue.lose(new Error("The turn was stopped."));
        });
        await instruct(c, sessionId, turn, session.created);
        const clock = turnWatchdog(timeouts);
        const own = sessionFamily(
            sessionId,
            turn.gate === undefined ? undefined : { gate: turn.gate, push: (frame) => queue.push({ type: "intentic.frame", frame }), hold: clock.hold },
            openCode.judges,
        );
        family = own;
        // Listening starts before the prompt, so none of the session's events is missed; the stream itself is the
        // server's, open since it booted.
        stopListening = lease.listen({
            event: (event) => {
                if (own.whose(event) !== undefined) {
                    queue.push(event);
                }
            },
            lost: queue.lose,
        });
        unmount = await openCode.mount(turn.cwd, turn.sealed === true ? [] : mcpServersOf(mounts));
        yield { type: "intentic.session", sessionId, created: session.created };
        const prompt = async (): Promise<void> => {
            // A Stop during setup interrupted a session with nothing running yet; a prompt sent now would start an
            // execution that outlives the turn, unjudged once it lets go.
            if (turn.signal.aborted) {
                return;
            }
            await c.session.prompt({ sessionID: sessionId, text: turn.prompt, ...(turn.images === undefined || turn.images.length === 0 ? {} : { files: [...turn.images] }) });
            // Stopped while the prompt went out: that interrupt may have reached the session before this execution did.
            if (turn.signal.aborted) {
                stopping = interrupt(c, sessionId);
            }
        };
        await prompt();
        clock.touch();
        // The self-heal remains xAI-specific. Google must never silently substitute another model.
        const selfHeals = (turn.provider ?? OPENCODE_XAI_PROVIDER) === OPENCODE_XAI_PROVIDER;
        yield* consumeTurn({
            turn,
            sessionId,
            queue,
            clock,
            family: own,
            // xAI names the account's valid models when it rejects a stale or renamed id: they are recorded and the same
            // session asked again once on the first of them; a second failure falls through as a real error.
            heal: selfHeals
                ? async (suggestions) => {
                      await openCode.recordModels(suggestions);
                      await c.session.switchModel({ sessionID: sessionId, model: { providerID: OPENCODE_XAI_PROVIDER, id: suggestions[0] ?? "" } });
                      await prompt();
                  }
                : undefined,
            interruptSession: () => interrupt(c, sessionId),
        });
    } finally {
        stopListening();
        await stopping;
        // A background shell outliving its turn would wake the session with nobody judging what it does next.
        await Promise.all(
            [...(family?.shells() ?? [])].map((id) =>
                // allow(silent-catch): a shell that already ended has nothing left to stop
                c.shell.remove({ id, location: { directory: turn.cwd } }).catch(() => {}),
            ),
        );
        family?.release();
        await unmount();
        // allow(silent-catch): a session that could not be deleted holds one answered request and nothing to resume
        await (sealedSession === undefined ? undefined : c.session.remove({ sessionID: sealedSession }).catch(() => {}));
    }
}

export const createOpenCodeRunner = (openCode: OpenCodeService, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS): OpenCodeRunner =>
    async function* (turn) {
        const lease = await openCode.acquire({ providerID: turn.provider ?? OPENCODE_XAI_PROVIDER, ...opt("modelID", turn.model) });
        try {
            yield* runOpenCodeTurn(openCode, lease, turn, timeouts);
        } finally {
            lease.release();
        }
    };

// xAI surfaces an unknown/retired model id as a "model not found" error naming valid alternatives; OpenCode itself says
// "Model unavailable" for one it cannot route at all. Tagged so the client reloads the catalog and drops the bad pinned
// model.
const MODEL_INVALID = /model not found|does not exist|no such model|did you mean|model unavailable/i;

// Google's own NOT_FOUND sentence. The translator lists models from its built-in catalog, not per account, so a model it
// lists can still be one Google does not offer these accounts; Google answers 404 with this sentence. Coded
// `model-unavailable`, which hides the model from the picker for a day (usage/model-refusals.ts) instead of a bare
// sentence that names no model and invites the same send again.
const GOOGLE_NOT_FOUND = /requested entity was not found/i;

const googleRefusalFrame = (provider: string, model: string | undefined, message: string): AgentEvent | undefined =>
    provider === OPENCODE_GEMINI_PROVIDER && model !== undefined && model !== "" && GOOGLE_NOT_FOUND.test(message)
        ? modelUnavailableFrame(
              model,
              `Google refused ${model} for this sandbox's Google accounts ("${message}"): the translator lists it, but Google does not offer it to them.`,
          )
        : undefined;

// How OpenCode's failure sentences are coded, in this order: a model xAI rejected, then a spent allowance, which gets a
// retry-later notice instead of a Continue that would just re-fail, then a session past the model's window.
const OPENCODE_FAILURES: readonly VendorRule[] = [
    [(message) => MODEL_INVALID.test(message), "grok-model-invalid"],
    [isRateLimited, "rate_limit"],
    [isContextOverflowText, "context-overflow"],
];

// An execution's failure as its frame, coded off OpenCode's own sentence (an overflow its compaction could not clear is
// the provider's words, whichever provider said them).
const executionErrorFrame = (error: StructuredError): AgentEvent => vendorFailureFrame({ kind: "error", message: error.message }, OPENCODE_FAILURES);

// An in-turn provider retry, so the chat shows a wait rather than an apparent hang; `status: 429` lets the UI say it is
// rate-limiting rather than a dead turn. No maxAttempts: OpenCode names none, so none is invented.
const retryFrame = (retry: { readonly attempt: number; readonly at: number; readonly error: StructuredError }): AgentEvent => ({
    kind: "provider_retry",
    attempt: retry.attempt,
    nextAttemptAt: retry.at,
    ...(retry.error.status === 429 || isRateLimited(retry.error.message) ? { status: 429 } : {}),
});

// Normalizes one turn's OpenCode events onto AgentEvents, returning what it captured (the plan phase reads this off
// `yield*`). `holdText` accumulates text into one `plan` frame instead of streaming deltas; ends where the runner ends
// the turn, without emitting the terminal `done`.
async function* streamTurn(events: AsyncIterable<OpenCodeTurnEvent>, view: TurnView, holdText = false): AsyncGenerator<AgentEvent, TurnCapture> {
    const capture: TurnCapture = {};
    // Token/cost per model step (an agentic turn has several), summed once the turn ends.
    const usage = usageTotals();
    const cards = toolCards(view);
    // The subagents this turn's calls start, and their sessions' events put under those calls.
    const subagents = openCodeSubagents(cards, usage);
    // What text each block already streamed, so a block that ended with more than its deltas carried sends the rest.
    const streamed = new Map<string, number>();
    const text = function* (block: string, chunk: string, kind: "delta" | "thinking"): Generator<AgentEvent> {
        streamed.set(block, (streamed.get(block) ?? 0) + chunk.length);
        if (kind === "delta" && holdText) {
            capture.planText = (capture.planText ?? "") + chunk;
        } else {
            yield { kind, text: chunk };
        }
    };
    const rest = function* (block: string, whole: string, kind: "delta" | "thinking"): Generator<AgentEvent> {
        const before = streamed.get(block) ?? 0;
        if (whole.length > before) {
            yield* text(block, whole.slice(before), kind);
        }
    };

    for await (const event of events) {
        if (event.type === "intentic.frame") {
            yield event.frame;
            continue;
        }
        if (event.type === "intentic.session") {
            capture.sessionId = event.sessionId;
            if (event.created) {
                yield { kind: "session", sessionId: event.sessionId };
            }
            continue;
        }
        const session = sessionOf(event);
        if (session !== undefined && capture.sessionId !== undefined && session !== capture.sessionId) {
            yield* subagents.child(event, session);
            continue;
        }
        switch (event.type) {
            case "session.text.delta":
                yield* text(`t:${event.data.assistantMessageID}:${String(event.data.ordinal)}`, event.data.delta, "delta");
                break;
            case "session.text.ended":
                yield* rest(`t:${event.data.assistantMessageID}:${String(event.data.ordinal)}`, event.data.text, "delta");
                break;
            case "session.reasoning.delta":
                yield* text(`r:${event.data.assistantMessageID}:${String(event.data.ordinal)}`, event.data.delta, "thinking");
                break;
            case "session.reasoning.ended":
                yield* rest(`r:${event.data.assistantMessageID}:${String(event.data.ordinal)}`, event.data.text, "thinking");
                break;
            case "session.step.ended":
                usage.add(stepTokens(event), event.id);
                break;
            case "session.retry.scheduled":
                yield retryFrame(event.data);
                break;
            case "session.execution.failed":
                yield executionErrorFrame(event.data.error);
                capture.errored = true;
                return capture;
            default:
                if (isToolEvent(event)) {
                    yield* cards.frames(event);
                    yield* subagents.call(event);
                }
        }
    }
    const total = usage.frame();
    if (total !== undefined) {
        yield total;
    }
    return capture;
}

// The words a turn's standing instructions carry: a turn's own, or a sealed request's system prompt, which is the whole
// of what it is told besides its prompt.
const systemOf = (request: AgentRequest): string | undefined => (request.policy.sealed === true ? request.spec.systemPrompt : request.spec.systemAppend);

// The turn one OpenCode message runs as. Every message carries the same standing instructions, since a plan's two phases
// are two messages of one turn and the execute phase must not drop them.
const openCodeTurnOf =
    (request: AgentRequest, provider: string, gate: CommandGuard, mounts: OpenCodeMounts) =>
    (message: {
        readonly prompt: string;
        readonly images: readonly PromptFile[];
        readonly sessionId: string | undefined;
        readonly agent: OpenCodeTurn["agent"];
    }): OpenCodeTurn => ({
        prompt: message.prompt,
        ...(message.images.length > 0 ? { images: message.images } : {}),
        ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
        cwd: request.spec.cwd,
        ...(request.spec.model !== undefined ? { model: request.spec.model } : {}),
        provider,
        agent: message.agent,
        gate,
        mounts,
        ...opt("system", systemOf(request)),
        ...(request.policy.sealed === true ? { sealed: true as const } : {}),
        signal: request.signal,
    });

// Plan flow over the shared skeleton: a read-only turn on the `plan` agent whose text becomes the plan, then execution on
// `build` resumed on the same session. Pictures ride the first planning message only; every later message resumes the
// session whose history already holds them. No `question` frames: the capability row says `questions: false`.
const openCodePlan = (
    view: TurnView,
    runner: OpenCodeRunner,
    turnOf: ReturnType<typeof openCodeTurnOf>,
    prompt: string,
    firstImages: readonly PromptFile[],
): EmulatedPlan => {
    let images = firstImages;
    return {
        prompt: PLAN_PREAMBLE + prompt,
        async *plan(phasePrompt, sessionId) {
            const capture = yield* streamTurn(runner(turnOf({ prompt: phasePrompt, images, sessionId, agent: "plan" })), view, true);
            images = [];
            return planPhaseOf(capture);
        },
        execute: (sessionId) => streamTurn(runner(turnOf({ prompt: EXECUTE_PROMPT, images: [], sessionId, agent: "build" })), view),
    };
};

// A transport failure names neither what was unreachable nor why: said as the local OpenCode server the turn could not
// reach, since the next turn boots that server afresh (opencode.ts ensure).
const unreachableServer = (error: unknown, provider: string): string | undefined => {
    const transport =
        (error instanceof TypeError && error.message === "fetch failed") || (error as { readonly reason?: unknown } | undefined)?.reason === "Transport";
    if (!transport) {
        return undefined;
    }
    const cause = (error as { readonly cause?: unknown }).cause;
    const detail = cause instanceof Error ? ` (${cause.message})` : "";
    return `The local OpenCode server that runs ${openCodeBackendLabel(provider)} turns could not be reached${detail}. Send again: it is restarted for the next turn.`;
};

// A provider's loop on OpenCode's `provider` backend; capability limits are declared in the contract's agent-catalog.ts.
export const createOpenCodeAgent = (runner: OpenCodeRunner, provider: string = OPENCODE_XAI_PROVIDER) =>
    async function* runOpenCodeAgent(request: AgentRequest<ContainerCredential>): AsyncGenerator<AgentEvent> {
        // Pictures go to the model as pictures; everything else, including an unreadable picture, is named in the prompt
        // for the read tool.
        const attached = await loadAttachments(request.spec, true);
        const images: PromptFile[] = attached.images.map((image) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: basename(image.path) }));
        const prompt = withFileNote(request.spec.prompt, [...attached.files, ...attached.unread]);
        // Turn's safety wiring (guard/turn-gate.ts): rulebook answered over OpenCode's permission channel, a hold parked
        // on a card while the runner holds its watchdog (the capability record says `rulebook: "approval"`). Releasing
        // the gate as the turn ends settles a card OpenCode moved on from (a refused sibling ask stops its session).
        const { gate, release } = vendorTurnGate(request);
        // The turn's remote MCP servers, the same list Codex takes, mounted per phase by the runner.
        const mounts = openCodeMounts(request.spec.conversationId, request.tools.remote ?? []);
        const view: TurnView = { cwd: request.spec.cwd, toolName: mcpToolNameOf(mounts) };
        const turnOf = openCodeTurnOf(request, provider, gate, mounts);
        const turn = planMode(
            OPENCODE,
            request,
            () => openCodePlan(view, runner, turnOf, prompt, images),
            () => streamTurn(runner(turnOf({ prompt, images, sessionId: request.spec.sessionId, agent: "build" })), view),
        );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                if (event.kind === "error") {
                    surfacedError = true;
                    yield (event.code === undefined ? googleRefusalFrame(provider, request.spec.model, event.message) : undefined) ?? event;
                    continue;
                }
                yield event;
            }
        } catch (error) {
            if (!surfacedError) {
                const message =
                    unreachableServer(error, provider) ?? (error instanceof Error ? error.message : `${openCodeBackendLabel(provider)} agent failed`);
                // A thrown model-not-found gets the same code as the event path, so the client reloads the catalog and
                // drops the bad pinned model.
                yield googleRefusalFrame(provider, request.spec.model, message) ?? {
                    kind: "error",
                    message,
                    ...(MODEL_INVALID.test(message) ? { code: "grok-model-invalid" as const } : {}),
                };
            }
        } finally {
            // This turn's outside-content bit and any card still open die with the turn (guard/turn-taint.ts).
            release();
        }
        yield { kind: "done" };
    };
