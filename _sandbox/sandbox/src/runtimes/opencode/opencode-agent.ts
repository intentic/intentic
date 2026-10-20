import { basename } from "node:path";
import type { OpenCodeClient, OpenCodeEvent, PermissionRule } from "@opencode/client";
import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import { whenAborted } from "@intentic/base/async";
import { isFetchNetworkFailure, networkCodeOf } from "@intentic/base/errors";
import type { AgentRequest, OpenCodeCredential } from "../../agent/providers/agent-request.js";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import { withFileNote } from "../../sessions/vocabulary/attachment-note.js";
import { loadAttachments } from "../../agent/prompt/attachment-images.js";
import { vendorShellEnv } from "../../agent/run/vendor-shell-env.js";
import { workloadStamp } from "../../seams/workload-stamp.js";
import { type EmulatedPlan, EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { DEFAULT_TURN_TIMEOUTS, EXPIRED, type TurnTimeouts, type TurnWatchdog, turnWatchdog, withTurnCap } from "../decorators/turn-watchdog.js";
import { modelUnavailableFrame } from "../../agent/run/frames/error-frames.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import type { TurnRelay } from "../daemon-tools/turn-relay.js";
import { planPhaseOf, type TurnCapture, type TurnTokens, usageTotals } from "../decorators/vendor-events.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { opt } from "../../opt.js";
import { isChatModel, OPENCODE_XAI_PROVIDER, parseModelSuggestions } from "./xai-models.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { openCodeBackendLabel, type OpenCodeLease, type OpenCodeService } from "./opencode.js";
import { OPENCODE_AGENTS, SERVER_PERMISSIONS } from "./opencode-config.js";
import { allowlistRules } from "./allowlist/opencode-allowlist.js";
import { type ShellRoute, shellPaneOf, shellRouteOf } from "./shell/opencode-shell.js";
import { tmuxRunEnabled } from "../../agent/tools/agent-terminals.js";
import { type ApprovalVerdict, DEFAULT_MODE_ASKS, type PermissionAsk, type SessionJudge, type SessionJudges } from "./opencode-permissions.js";
import { isToolEvent, sessionOf, stepTokens, tokensOf, toolCards, type TurnView, unreportedTokens } from "./opencode-frames.js";
import { errorDetail, executionErrorFrame, type FailureTarget, isModelInvalid, retryFrame } from "./opencode-failures.js";
import { mcpServersOf, mcpToolNameOf, openCodeMounts, type OpenCodeMounts, sessionToolRules } from "./opencode-mcp.js";
import { openCodeSubagents } from "./opencode-subagents.js";
import { commandIn, commandsAt } from "./opencode-commands.js";
import {
    answerForm,
    type DaemonItem,
    FOLLOW_UP_MS,
    handover,
    type HandedOver,
    heardBefore,
    isDaemonItem,
    isExecutionEnd,
    noteCall,
    noteExecution,
    noteOutside,
    noteInbox,
    type RaisedFrame,
    readBack,
    sendSteer,
    SETTLED,
    settling,
    type TurnAsk,
    type TurnProgress,
    turnProgress,
    turnQueue,
    type TurnQueue,
    type TurnReading,
} from "./opencode-turn.js";

export type { RaisedFrame, TurnAsk } from "./opencode-turn.js";

// The OpenCode loop Grok and Gemini both run on: AgentRequest in, AgentEvent frames out, over one shared `opencode serve`.

// A picture as OpenCode's prompt takes it: a data URL, since the server is reached over HTTP and reads no path of ours.
export interface PromptFile {
    readonly uri: string;
    readonly name?: string;
}

// What a turn in `default` mode puts a per-tool card up for: one ask the rulebook let through, the card's frames going
// to `push` in order with the turn's own.
export type TurnApprove = (ask: PermissionAsk, push: (frame: AgentEvent) => void) => Promise<ApprovalVerdict>;

// One OpenCode turn: the runner creates or resumes its session and yields its events; injected so tests drive a fake stream.
export interface OpenCodeTurn {
    readonly prompt: string;
    readonly sessionId?: string;
    readonly cwd: string;
    readonly model?: string;
    // OpenCode's provider id to drive this turn on; absent means xAI. Per-turn: one shared opencode serve carries both
    // providers.
    readonly provider?: string;
    // Which agent runs it: "plan" is read-only (proposes), "build" executes.
    readonly agent: "plan" | "build";
    // Whether `system` is the whole system text rather than an addition to OpenCode's own base prompt: the turn then runs
    // on the daemon's twin of its agent, whose base is blank (opencode-config.ts OPENCODE_AGENTS).
    readonly replacesBase?: true;
    // The reasoning tier the turn asked for, sent as the session's model variant where the model declares that tier.
    readonly effort?: string;
    // The whole environment the session's shell runs with (OpenCode's `session.environment` replaces it outright): the
    // daemon's own, the turn's cli-kind credentials, its heavy-command lane and the conversation's workload stamp.
    readonly env?: Readonly<Record<string, string>>;
    // Command-rulebook gate for this turn, registered against the session id once it exists; absent means every
    // permission gets the standing yes.
    readonly gate?: CommandGuard;
    // A turn in `default` mode: who answers the per-tool card for an edit, a fetch or a command the rulebook let through.
    readonly approve?: TurnApprove;
    // The turn's tool list (TurnPolicy.allowedTools): its session offered only the listed tools (allowlist/opencode-allowlist.ts),
    // and every command its shell runs checked against the list's shell entries.
    readonly allowedTools?: readonly string[];
    // How a command its sessions' shell runs is routed (shell/opencode-shell.ts), for the session it is created on, a card for
    // the panel going to `push`: in the conversation's terminal pane, its secret references resolved, its output masked.
    readonly shell?: (sessionId: string, push: (frame: AgentEvent) => void) => ShellRoute;
    // Who answers a form the session raises (OpenCode's `question` tool); absent cancels every form.
    readonly ask?: TurnAsk;
    // The daemon's own servers' late half (turn-relay.ts): attached once this message's queue and watchdog exist, so a
    // card a door tool raises lands in the turn's stream, a call it runs holds the watchdog, and a script it runs is
    // checked against the turn's gate and marks its taint bit.
    readonly relay?: TurnRelay;
    readonly taint?: TurnTaint;
    // Messages steered into the running turn, sent as OpenCode steers; `closeSteering` ends admission once the turn is
    // done, so a message arriving later becomes the next turn instead.
    readonly steering?: AsyncIterable<string>;
    readonly closeSteering?: () => void;
    // Whether the turn publishes the slash commands OpenCode offers here and runs a `/name` prompt as one.
    readonly commands?: boolean;
    // The turn's MCP servers, mounted for the turn under its conversation's own names (opencode-mcp.ts); absent mounts
    // none, and the turn still sees no other conversation's.
    readonly mounts?: OpenCodeMounts;
    // Standing instructions, set as the session's own instruction entry and set again by every message: added to
    // OpenCode's base prompt, or, with `replacesBase`, the whole of it.
    readonly system?: string;
    // Images already read off disk, sent as native parts rather than named as paths in the prompt; read in the adapter
    // so an unreadable one falls back to a prompt note.
    readonly images?: readonly PromptFile[];
    // A sealed request (agent-request.ts `policy.sealed`): every tool denied, and its session deleted once it answered,
    // since nothing resumes it.
    readonly sealed?: true;
    // The turn's hard cap in place of the runner's default (TurnSpec.turnCapMs, the owner's setting).
    readonly capMs?: number;
    readonly signal: AbortSignal;
}

// Every tool denied, OpenCode's own included: the wildcard keeps this from tracking OpenCode's tool names in step.
const NO_TOOLS: readonly PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];

// The session's own instruction entry the turn's standing instructions ride in; one key, replaced by every message.
const INSTRUCTIONS_KEY = "intentic";

// The session the turn runs on, said before any of its events; `created` when this turn made it, and what the session
// had spent before this turn (its running total), so what OpenCode spends for it beyond the turn's steps is counted.
export interface TurnSession {
    readonly type: "intentic.session";
    readonly sessionId: string;
    readonly created: boolean;
    readonly spent?: TurnTokens;
}
export type OpenCodeTurnEvent = OpenCodeEvent | RaisedFrame | TurnSession | HandedOver;
export type OpenCodeRunner = (turn: OpenCodeTurn) => AsyncIterable<OpenCodeTurnEvent>;

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
                return shells.delete(event.data.id) ? "shell" : undefined;
            }
            if (event.type === "session.created" && event.data.parentID !== undefined && members.has(event.data.parentID)) {
                join(event.data.sessionID);
            }
            const session = sessionOf(event);
            if (session === undefined || !members.has(session)) {
                return undefined;
            }
            // A shell call's own shell: its id rides the call's progress, and it stays the turn's until it exits.
            if (event.type === "session.tool.progress" && typeof event.data.metadata["shellID"] === "string") {
                shells.add(event.data.metadata["shellID"]);
            }
            return session === root ? "own" : "subagent";
        },
        // Shells still running.
        shells: (): ReadonlySet<string> => shells,
        // The family's sessions, its own first.
        members: (): ReadonlySet<string> => members,
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
const modelSuggestions = (message: string): string[] => (isModelInvalid(message) ? parseModelSuggestions(message).filter(isChatModel) : []);

// The steering a turn borrows, pumped onto its queue; `close` ends admission and resolves once every message that made
// it in before then is on the queue.
interface TurnSteering {
    open: boolean;
    readonly close: () => Promise<void>;
}

const pumpSteering = (turn: OpenCodeTurn, queue: TurnQueue): TurnSteering | undefined => {
    const steering = turn.steering;
    if (steering === undefined) {
        return undefined;
    }
    const pumped = (async () => {
        for await (const text of steering) {
            queue.push({ type: "intentic.steer", text });
        }
    })();
    const state: TurnSteering = {
        open: true,
        close: async () => {
            state.open = false;
            turn.closeSteering?.();
            // allow(silent-catch): a relay that failed has nothing left to hand over
            await pumped.catch(() => {});
        },
    };
    return state;
};

// What reading one turn holds: the session it drives, the clock and queue it reads under, the family it reads for, the
// steering it takes, and the xAI self-heal it may spend once.
interface Consumed {
    readonly turn: OpenCodeTurn;
    readonly reading: TurnReading;
    readonly family: ReturnType<typeof sessionFamily>;
    readonly steering: TurnSteering | undefined;
    // Re-prompts on one of xAI's suggested models after a rejection naming them; undefined once spent or never offered.
    heal: ((suggestions: string[]) => Promise<void>) | undefined;
    // A mounted tool's key as the daemon spells an MCP call, for what its result brings in (opencode-mcp.ts).
    readonly outsideName: (raw: string) => string;
}

// A turn with no taint bit to mark: what it reads in is nobody's to record.
const noMark = (): void => {};

// Whether the turn is done waiting once its own work ended. Its steering closes last, and a message that made it in
// before that is sent, so the turn goes on with it rather than dropping it.
const finished = async (consumed: Consumed, progress: TurnProgress): Promise<boolean> => {
    if (settling(progress, consumed.family.shells().size, consumed.reading.clock) === "wait") {
        return false;
    }
    if (consumed.steering?.open !== true) {
        return true;
    }
    await consumed.steering.close();
    return !consumed.reading.queue.waiting();
};

// What an expired watchdog means for the turn: silence past its limit is a provider that stopped answering mid-turn,
// coded so the daemon re-runs it on backoff; reaching the hard cap is not, and ends the turn as a plain failure.
const expired = (consumed: Consumed, label: string): HandedOver | Error => {
    const why = `${label} turn on the OpenCode loop timed out: ${consumed.reading.clock.expiry()}.`;
    return consumed.reading.clock.capRemaining() > 0
        ? { type: "intentic.failed", frame: { kind: "error", code: "provider-outage", message: why, own: true } }
        : new Error(why);
};

// The turn's own session's ending, where it ends the turn: an interruption the turn did not ask for is a failure naming
// why; a failure xAI named alternatives for is healed once instead.
const ownEnding = async (consumed: Consumed, item: OpenCodeEvent, label: string): Promise<"healed" | undefined> => {
    if (item.type === "session.execution.failed" && consumed.heal !== undefined) {
        const suggestions = modelSuggestions(errorDetail(item.data.error));
        if (suggestions[0] !== undefined) {
            const healing = consumed.heal;
            consumed.heal = undefined;
            await healing(suggestions);
            return "healed";
        }
    }
    if (item.type === "session.execution.interrupted" && !consumed.turn.signal.aborted) {
        throw new Error(`OpenCode stopped the ${label} turn (${item.data.reason}).`);
    }
    return undefined;
};

// What the daemon does for the items it queued for itself: a steer sent, a read-back started, a form found standing put
// on a card; a wake only has the turn look again at whether it is done.
const daemonItem = async (consumed: Consumed, progress: TurnProgress, item: DaemonItem): Promise<void> => {
    switch (item.type) {
        case "intentic.steer":
            // A stopped turn sends nothing more: a steer now would start an execution nobody is reading.
            if (!consumed.turn.signal.aborted) {
                await sendSteer(consumed.reading, progress, item.text);
            }
            return;
        case "intentic.resumed":
            void readBack(consumed.reading, progress);
            return;
        case "intentic.form":
            answerForm(consumed.reading, progress, item.form);
            return;
        case "intentic.wake":
            return;
    }
};

// Reads one turn's session family until its work is done. The turn's own session ends each execution with one of three
// events; a success is the end unless something the turn started is still to report (a background shell, a subagent, a
// steer on its way, a form on a card), in which case OpenCode wakes the session again when it does, and the turn waits
// for that execution too. The setup/cleanup owner keeps its runtime leased throughout.
async function* consumeTurn(consumed: Consumed): AsyncGenerator<OpenCodeTurnEvent> {
    const { turn, reading } = consumed;
    const { sessionId, queue, clock } = reading;
    const label = openCodeBackendLabel(turn.provider ?? OPENCODE_XAI_PROVIDER);
    const progress = turnProgress();
    for (;;) {
        const item = await queue.next(clock, progress.followUpUntil);
        if (item === EXPIRED) {
            await interrupt(reading.client, sessionId);
            // Named by the loop that actually ran it: Gemini and Grok turns run on OpenCode whatever loop the
            // conversation's card names.
            const outcome = expired(consumed, label);
            if (outcome instanceof Error) {
                throw outcome;
            }
            yield outcome;
            return;
        }
        if (item === SETTLED) {
            progress.followUpUntil = undefined;
            if (progress.backgroundUntil !== undefined || (await finished(consumed, progress))) {
                return;
            }
            continue;
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
        if (isDaemonItem(item)) {
            await daemonItem(consumed, progress, item);
        } else if ((yield* ownEvent(consumed, progress, item, label)) === "ended") {
            return;
        }
        if (progress.ownEnded && progress.running.size === 0 && (await finished(consumed, progress))) {
            return;
        }
    }
}

// One of OpenCode's events for the turn: its bookkeeping, then the event itself for the frames. "ended" once the turn's
// own session ended it (a failure, an interruption, a retry handed over).
async function* ownEvent(
    consumed: Consumed,
    progress: TurnProgress,
    item: OpenCodeEvent,
    label: string,
): AsyncGenerator<OpenCodeTurnEvent, "ended" | undefined> {
    const { reading } = consumed;
    const { sessionId, clock } = reading;
    if (heardBefore(progress, item)) {
        return undefined;
    }
    clock.touch();
    const session = sessionOf(item);
    noteExecution(progress, item, sessionId);
    noteInbox(progress, item, sessionId);
    noteCall(progress, item, clock);
    noteOutside(progress, item, consumed.outsideName, consumed.turn.taint?.mark ?? noMark);
    // A background shell or subagent that ended after the turn's own work did is what the session is woken with.
    const backgroundEnded = item.type === "shell.exited" || item.type === "shell.deleted" || (session !== sessionId && isExecutionEnd(item));
    if (backgroundEnded && progress.ownEnded) {
        progress.followUpUntil = Date.now() + FOLLOW_UP_MS;
        progress.backgroundUntil = undefined;
    }
    if (item.type === "form.created") {
        answerForm(reading, progress, item.data.form);
        return undefined;
    }
    if (session === sessionId) {
        if (item.type === "session.retry.scheduled") {
            const handed = handover(item, clock);
            if (handed !== undefined) {
                await interrupt(reading.client, sessionId);
                yield item;
                yield handed;
                return "ended";
            }
            // Move inactivity past a retry's next attempt, still bounded by the hard turn cap.
            clock.extendPast(item.data.at);
        }
        if ((await ownEnding(consumed, item, label)) === "healed") {
            return undefined;
        }
    }
    if (item.type !== "shell.exited" && item.type !== "shell.deleted") {
        yield item;
    }
    return session === sessionId && (item.type === "session.execution.failed" || item.type === "session.execution.interrupted") ? "ended" : undefined;
}

// The session a turn runs on: the one it resumes, set up for this message, else a new one, named on creation so
// OpenCode skips auto-titling (an extra model call per unnamed session). Answers what the session had spent so far.
const sessionFor = async (
    c: OpenCodeClient,
    turn: OpenCodeTurn,
    rules: readonly PermissionRule[],
    variant: string | undefined,
): Promise<{ id: string; created: boolean; spent: TurnTokens | undefined }> => {
    const model =
        turn.model === undefined || turn.model === ""
            ? undefined
            : { providerID: turn.provider ?? OPENCODE_XAI_PROVIDER, id: turn.model, ...opt("variant", variant) };
    const agent = turn.replacesBase === true ? OPENCODE_AGENTS[turn.agent] : turn.agent;
    if (turn.sessionId === undefined) {
        const created = await c.session.create({
            location: { directory: turn.cwd },
            title: "intentic conversation",
            agent,
            ...opt("model", model),
            permissions: [...rules],
        });
        return { id: created.id, created: true, spent: tokensOf(created.tokens, created.cost) };
    }
    const sessionID = turn.sessionId;
    // A session keeps its rules, agent and model; each message sets the ones it runs with.
    await c.session.update({ sessionID, permissions: [...rules] });
    await c.session.switchAgent({ sessionID, agent });
    if (model !== undefined) {
        await c.session.switchModel({ sessionID, model });
    }
    // allow(silent-catch): a total that cannot be read leaves only the steps' own spend counted, as before
    const info = await c.session.get({ sessionID }).catch(() => undefined);
    return { id: sessionID, created: false, spent: info === undefined ? undefined : tokensOf(info.tokens, info.cost) };
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

// Sends the turn's message: as the command it names, its notes first as context the command's execution takes in, or
// as a prompt.
const sendPrompt = async (c: OpenCodeClient, sessionID: string, turn: OpenCodeTurn, commands: readonly AgentCommand[]): Promise<void> => {
    const files = turn.images === undefined || turn.images.length === 0 ? undefined : [...turn.images];
    const command = commandIn(turn.prompt, commands);
    if (command === undefined) {
        await c.session.prompt({ sessionID, text: turn.prompt, ...opt("files", files) });
        return;
    }
    if (command.notes !== "") {
        await c.session.synthetic({ sessionID, text: command.notes, resume: false });
    }
    await c.session.command({ sessionID, name: command.name, text: command.text, ...opt("files", files) });
};

// The judge a turn's sessions answer to: its rulebook, its cards, its hold on the watchdog, and in `default` mode the
// per-tool card. None for an ungated turn, whose every ask gets the standing yes.
const judgeOf = (turn: OpenCodeTurn, sessionId: string, queue: TurnQueue, clock: TurnWatchdog): SessionJudge | undefined => {
    if (turn.gate === undefined) {
        return undefined;
    }
    const push = (frame: AgentEvent): void => queue.push({ type: "intentic.frame", frame });
    const approve = turn.approve;
    return {
        gate: turn.gate,
        push,
        hold: clock.hold,
        ...opt("allowedTools", turn.allowedTools),
        ...opt("shell", turn.shell?.(sessionId, push)),
        ...opt(
            "approve",
            approve === undefined
                ? undefined
                : async (ask: PermissionAsk): Promise<ApprovalVerdict> => {
                      const release = clock.hold();
                      try {
                          return await approve(ask, push);
                      } finally {
                          release();
                      }
                  },
        ),
    };
};

// The rules a turn's session runs with: none for a sealed request; a turn's tool list, which denies everything else
// (allowlist/opencode-allowlist.ts); else its mounted servers' (opencode-mcp.ts). In `default` mode, the asks that put edits and
// fetches on a per-tool card.
const rulesOf = (turn: OpenCodeTurn, mounts: OpenCodeMounts): PermissionRule[] => {
    if (turn.sealed === true) {
        return [...NO_TOOLS];
    }
    const asks = turn.approve === undefined ? [] : DEFAULT_MODE_ASKS;
    return turn.allowedTools === undefined
        ? [...sessionToolRules(mounts), ...asks]
        : allowlistRules(turn.allowedTools, mounts, { plan: turn.agent === "plan", asks, serverAsks: SERVER_PERMISSIONS });
};

// Runs on a leased client; even setup before the session has a judge belongs to this turn's server lifetime.
async function* runOpenCodeTurn(
    openCode: OpenCodeService,
    lease: OpenCodeLease,
    turn: OpenCodeTurn,
    timeouts: TurnTimeouts,
): AsyncGenerator<OpenCodeTurnEvent> {
    const c = lease.client;
    let family: ReturnType<typeof sessionFamily> | undefined;
    let stopListening = (): void => {};
    let detachRelay = (): void => {};
    let unmount = async (): Promise<void> => {};
    let sealedSession: string | undefined;
    let steering: TurnSteering | undefined;
    // The interrupt a Stop sent; the turn's judges stay in place until OpenCode has taken it, since an ask from a session
    // nobody judges is answered with the standing yes.
    let stopping: Promise<void> | undefined;
    try {
        const mounts = turn.mounts ?? openCodeMounts(undefined, []);
        const provider = turn.provider ?? OPENCODE_XAI_PROVIDER;
        const variant = turn.model === undefined ? undefined : openCode.variant(provider, turn.model, turn.effort);
        const session = await sessionFor(c, turn, rulesOf(turn, mounts), variant);
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
        if (turn.env !== undefined && turn.sealed !== true) {
            await c.session.environment({ sessionID: sessionId, variables: { ...turn.env } });
        }
        const clock = turnWatchdog(withTurnCap(timeouts, turn.capMs));
        detachRelay = attachRelay(turn, queue, clock);
        const own = sessionFamily(sessionId, judgeOf(turn, sessionId, queue, clock), openCode.judges);
        family = own;
        // Listening starts before the prompt, so none of the session's events is missed; the stream itself is the
        // server's, open since it booted.
        stopListening = listenFor(lease, own, queue);
        unmount = await openCode.mount(turn.cwd, turn.sealed === true ? [] : mcpServersOf(mounts));
        yield { type: "intentic.session", sessionId, created: session.created, ...opt("spent", session.spent) };
        const commands = turn.commands === true && turn.sealed !== true ? await commandsAt(c, turn.cwd) : [];
        if (commands.length > 0) {
            yield { type: "intentic.frame", frame: { kind: "commands", items: commands } };
        }
        const prompt = async (): Promise<void> => {
            // A Stop during setup interrupted a session with nothing running yet; a prompt sent now would start an
            // execution that outlives the turn, unjudged once it lets go.
            if (turn.signal.aborted) {
                return;
            }
            await sendPrompt(c, sessionId, turn, commands);
            // Stopped while the prompt went out: that interrupt may have reached the session before this execution did.
            if (turn.signal.aborted) {
                stopping = interrupt(c, sessionId);
            }
        };
        await prompt();
        clock.touch();
        steering = pumpSteering(turn, queue);
        yield* consumeTurn({
            turn,
            reading: { client: c, sessionId, queue, clock, ask: turn.ask, members: own.members, signal: turn.signal },
            family: own,
            steering,
            heal: healOf(openCode, c, provider, sessionId, prompt),
            outsideName: mcpToolNameOf(mounts),
        });
    } finally {
        // A turn that ended any other way than settling still closes its steering, so a later message is the next turn.
        await steering?.close();
        stopListening();
        detachRelay();
        await stopping;
        await cleanUp(c, turn, family);
        await unmount();
        // allow(silent-catch): a session that could not be deleted holds one answered request and nothing to resume
        await (sealedSession === undefined ? undefined : c.session.remove({ sessionID: sealedSession }).catch(() => {}));
    }
}

// The daemon's servers attached to this message: their frames on its queue in order with OpenCode's, their calls holding
// its watchdog, their scripts consulted against its gate; detached as the message ends, so the next phase's attach takes
// over and anything a tool does in between waits in the relay.
const attachRelay = (turn: OpenCodeTurn, queue: TurnQueue, clock: TurnWatchdog): (() => void) =>
    turn.relay?.attach({
        push: (frame) => queue.push({ type: "intentic.frame", frame }),
        hold: clock.hold,
        ...opt("guard", turn.gate === undefined || turn.taint === undefined ? undefined : { gate: turn.gate, taint: turn.taint }),
    }) ?? (() => {});

// The turn's own reading of the server's one stream: its family's events, the stream's loss, and its reopening.
const listenFor = (lease: OpenCodeLease, own: ReturnType<typeof sessionFamily>, queue: TurnQueue): (() => void) =>
    lease.listen({
        event: (event) => {
            if (own.whose(event) !== undefined) {
                queue.push(event);
            }
        },
        lost: queue.lose,
        resumed: () => queue.push({ type: "intentic.resumed" }),
    });

// xAI names the account's valid models when it rejects a stale or renamed id: they are recorded and the same session
// asked again once on the first of them; a second failure falls through as a real error. xAI's only: Google must never
// silently substitute another model.
const healOf = (
    openCode: OpenCodeService,
    c: OpenCodeClient,
    provider: string,
    sessionId: string,
    prompt: () => Promise<void>,
): ((suggestions: string[]) => Promise<void>) | undefined =>
    provider === OPENCODE_XAI_PROVIDER
        ? async (suggestions) => {
              await openCode.recordModels(suggestions);
              await c.session.switchModel({ sessionID: sessionId, model: { providerID: OPENCODE_XAI_PROVIDER, id: suggestions[0] ?? "" } });
              await prompt();
          }
        : undefined;

// What a turn leaves running behind it, taken back: its shells and its judges.
const cleanUp = async (c: OpenCodeClient, turn: OpenCodeTurn, family: ReturnType<typeof sessionFamily> | undefined): Promise<void> => {
    // A background shell outliving its turn would wake the session with nobody judging what it does next.
    await Promise.all(
        [...(family?.shells() ?? [])].map((id) =>
            // allow(silent-catch): a shell that already ended has nothing left to stop
            c.shell.remove({ id, location: { directory: turn.cwd } }).catch(() => {}),
        ),
    );
    family?.release();
};

export const createOpenCodeRunner = (openCode: OpenCodeService, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS): OpenCodeRunner =>
    async function* (turn) {
        const lease = await openCode.acquire({ providerID: turn.provider ?? OPENCODE_XAI_PROVIDER, ...opt("modelID", turn.model) });
        try {
            yield* runOpenCodeTurn(openCode, lease, turn, timeouts);
        } finally {
            lease.release();
        }
    };

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

// What a turn's frames are read against beyond its view: who its failures are coded against.
interface StreamContext {
    readonly view: TurnView;
    readonly target: FailureTarget;
}

// A turn's spend: each model step's (an agentic turn has several), and its own session's running total, which also
// holds what OpenCode spent for the session beyond its steps (a title, a compaction).
const turnSpend = () => {
    const usage = usageTotals();
    let before: TurnTokens | undefined;
    let after: TurnTokens | undefined;
    const steps: TurnTokens[] = [];
    return {
        usage,
        // What the session had spent before this turn.
        from: (spent: TurnTokens | undefined): void => {
            before = spent;
        },
        // One of the turn's own session's steps, and its running total as it moves.
        step: (tokens: TurnTokens, key: string): void => {
            steps.push(tokens);
            usage.add(tokens, key);
        },
        total: (tokens: TurnTokens): void => {
            after = tokens;
        },
        frame: (): AgentEvent | undefined => {
            if (before !== undefined && after !== undefined) {
                const reported = steps.reduce(
                    (sum, step) => ({
                        inputTokens: sum.inputTokens + step.inputTokens,
                        outputTokens: sum.outputTokens + step.outputTokens,
                        cacheReadTokens: sum.cacheReadTokens + step.cacheReadTokens,
                        cacheCreationTokens: sum.cacheCreationTokens + step.cacheCreationTokens,
                        costUsd: (sum.costUsd ?? 0) + (step.costUsd ?? 0),
                    }),
                    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
                );
                usage.add(unreportedTokens(before, after, reported), "unreported");
            }
            return usage.frame();
        },
    };
};

// What the runner says besides OpenCode's events: a card, a failure it handed over (which ends the turn), the session.
function* runnerEvent(
    event: RaisedFrame | HandedOver | TurnSession,
    capture: TurnCapture,
    spend: ReturnType<typeof turnSpend>,
): Generator<AgentEvent, "ended" | undefined> {
    switch (event.type) {
        case "intentic.frame":
            yield event.frame;
            return undefined;
        case "intentic.failed":
            yield event.frame;
            capture.errored = true;
            return "ended";
        case "intentic.session":
            capture.sessionId = event.sessionId;
            spend.from(event.spent);
            if (event.created) {
                yield { kind: "session", sessionId: event.sessionId };
            }
            return undefined;
    }
}

// Normalizes one turn's OpenCode events onto AgentEvents, returning what it captured (the plan phase reads this off
// `yield*`). `holdText` accumulates text into one `plan` frame instead of streaming deltas; ends where the runner ends
// the turn, without emitting the terminal `done`.
async function* streamTurn(
    events: AsyncIterable<OpenCodeTurnEvent>,
    context: StreamContext,
    holdText = false,
): AsyncGenerator<AgentEvent, TurnCapture> {
    const capture: TurnCapture = {};
    const spend = turnSpend();
    const cards = toolCards(context.view);
    // The subagents this turn's calls start, and their sessions' events put under those calls.
    const subagents = openCodeSubagents(cards, spend.usage);
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
        if (event.type === "intentic.frame" || event.type === "intentic.failed" || event.type === "intentic.session") {
            if ((yield* runnerEvent(event, capture, spend)) === "ended") {
                return capture;
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
                spend.step(stepTokens(event), event.id);
                break;
            case "session.usage.updated":
                spend.total(tokensOf(event.data.tokens, event.data.cost));
                break;
            case "session.retry.scheduled":
                yield retryFrame(event.data);
                break;
            case "session.execution.failed":
                yield executionErrorFrame(event.data.error, context.target);
                capture.errored = true;
                return capture;
            default:
                if (isToolEvent(event)) {
                    yield* cards.frames(event);
                    yield* subagents.call(event);
                }
        }
    }
    const total = spend.frame();
    if (total !== undefined) {
        yield total;
    }
    return capture;
}

// The words a turn's system text carries: a sealed request's system prompt (the whole of what it is told besides its
// prompt), else the turn's own composition (system-prompt.ts): a prompt that replaces the base (the owner's own under
// `custom`, or the one paragraph a small window takes), or the daemon's additions to OpenCode's own base.
const systemOf = (request: AgentRequest): string | undefined =>
    request.policy.sealed === true ? request.spec.systemPrompt : (request.spec.systemPrompt ?? request.spec.systemAppend);

// Whether the turn's system text replaces OpenCode's base prompt rather than adding to it.
const replacesBase = (request: AgentRequest): boolean => request.spec.systemPrompt !== undefined;

// The environment the session's shell runs with, whole, since OpenCode's `session.environment` replaces rather than
// adds: the daemon's own, the turn's cli-kind credentials, the conversation's workload stamp, then the heavy-command
// lane the shell's programs are queued by (vendor-shell-env.ts), as a Codex turn's shell gets them.
const turnEnv = async (request: AgentRequest): Promise<Record<string, string>> => {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            inherited[key] = value;
        }
    }
    const base = {
        ...inherited,
        ...request.tools.cliEnv,
        ...(request.spec.conversationId === undefined ? {} : workloadStamp(request.spec.conversationId)),
    };
    return { ...base, ...(await vendorShellEnv(request.tools, base)) };
};

// Who answers a turn's forms: its card registry, a question card per form, frozen with its answer.
const askVia =
    (request: AgentRequest): TurnAsk =>
    async (questions, push) => {
        const { id, wait } = request.hooks.cards.create(
            "question",
            { kind: "question", requestId: "", cancelled: true },
            request.spec.conversationId,
        );
        push({ kind: "question", requestId: id, questions: [...questions] });
        const { reply, resolved } = await wait(request.signal);
        push(resolved);
        return reply;
    };

// The per-tool card a `default`-mode turn raises for an ask the rulebook let through, as the Claude loop's is raised.
// "Always" holds for the rest of this turn only: OpenCode would keep an always as a rule for the whole project, which
// every later ask there would skip, the owner's rulebook included, so it is never passed on.
const approveVia = (request: AgentRequest): TurnApprove => {
    const always = new Set<string>();
    return async (ask, push) => {
        if (always.has(ask.kind)) {
            return { allow: true };
        }
        const tool = displayNameOf(ask.kind);
        const { id, wait } = request.hooks.cards.create("permission", {
            kind: "permission",
            requestId: "",
            decision: "deny",
            feedback: "The turn was cancelled before you answered.",
        });
        push({
            kind: "permission",
            requestId: id,
            toolName: tool,
            displayName: tool,
            reason: "mode",
            ...opt("description", ask.resources.length === 0 ? undefined : ask.resources.join("\n")),
            alwaysLabel: `Don't ask again for ${tool} this turn`,
        });
        const { reply, resolved } = await wait(request.signal);
        push(resolved);
        if (reply.decision === "deny") {
            // Feedback redirects and the turn goes on; a bare no stops it, as the Claude loop's card does.
            const reason = reply.feedback?.trim() ?? "";
            return {
                allow: false,
                reason:
                    reason === ""
                        ? `The user declined ${tool} and stopped the turn. STOP what you are doing and wait for them to say how to proceed.`
                        : reason,
            };
        }
        if (reply.decision === "always") {
            always.add(ask.kind);
        }
        return { allow: true };
    };
};

// What every message of one turn shares: everything but its words, pictures, session and agent.
interface TurnBase {
    readonly request: AgentRequest;
    readonly provider: string;
    readonly gate: CommandGuard;
    readonly taint: TurnTaint;
    readonly mounts: OpenCodeMounts;
    readonly env?: Readonly<Record<string, string>>;
    readonly shell?: OpenCodeTurn["shell"];
    // The turn's steering, lent to one phase at a time (agent-steering.ts steeringRelay).
    readonly steering?: () => SteeringChannel;
}

// The turn one OpenCode message runs as. Every message carries the same standing instructions, since a plan's two phases
// are two messages of one turn and the execute phase must not drop them. A planning phase lends its steering on (closing
// only its own channel, so a message arriving while the plan waits on its card reaches the execute phase); any other
// closes the turn's queue, so a message arriving after it is the next turn.
const openCodeTurnOf =
    (base: TurnBase) =>
    (
        message: {
            readonly prompt: string;
            readonly images: readonly PromptFile[];
            readonly sessionId: string | undefined;
            readonly agent: OpenCodeTurn["agent"];
        },
        channel?: SteeringChannel,
    ): OpenCodeTurn => {
        const { request } = base;
        const sealed = request.policy.sealed === true;
        return {
            prompt: message.prompt,
            ...(message.images.length > 0 ? { images: message.images } : {}),
            ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
            cwd: request.spec.cwd,
            ...(request.spec.model !== undefined ? { model: request.spec.model } : {}),
            provider: base.provider,
            agent: message.agent,
            ...opt("replacesBase", replacesBase(request) ? (true as const) : undefined),
            ...opt("effort", request.spec.effort),
            ...opt("env", base.env),
            gate: base.gate,
            ...opt("relay", sealed ? undefined : request.hooks.relay),
            taint: base.taint,
            ...opt("approve", !sealed && request.policy.permissionMode === "default" ? approveVia(request) : undefined),
            ...opt("allowedTools", request.policy.allowedTools),
            ...opt("shell", sealed ? undefined : base.shell),
            ...opt("ask", sealed ? undefined : askVia(request)),
            ...opt("steering", channel?.steering),
            ...opt(
                "closeSteering",
                channel === undefined ? undefined : message.agent === "plan" ? channel.close : () => request.spec.steering?.close(),
            ),
            commands: !sealed,
            mounts: base.mounts,
            ...opt("system", systemOf(request)),
            ...(sealed ? { sealed: true as const } : {}),
            ...opt("capMs", request.spec.turnCapMs),
            signal: request.signal,
        };
    };

// One phase's run, with the turn's steering lent to it for its length.
const phaseRun = (runner: OpenCodeRunner, base: TurnBase, turnOf: ReturnType<typeof openCodeTurnOf>) =>
    async function* (
        message: Parameters<ReturnType<typeof openCodeTurnOf>>[0],
        context: StreamContext,
        holdText = false,
    ): AsyncGenerator<AgentEvent, TurnCapture> {
        const channel = base.steering?.();
        try {
            return yield* streamTurn(runner(turnOf(message, channel)), context, holdText);
        } finally {
            // Leaving the channel open would park the steering pump on a promise nothing resolves.
            channel?.close();
        }
    };

// Plan flow over the shared skeleton: a read-only turn on the plan agent whose text becomes the plan, then execution on
// build resumed on the same session. Pictures ride the first planning message only; every later message resumes the
// session whose history already holds them.
const openCodePlan = (context: StreamContext, run: ReturnType<typeof phaseRun>, prompt: string, firstImages: readonly PromptFile[]): EmulatedPlan => {
    let images = firstImages;
    return {
        prompt: PLAN_PREAMBLE + prompt,
        async *plan(phasePrompt, sessionId) {
            const capture = yield* run({ prompt: phasePrompt, images, sessionId, agent: "plan" }, context, true);
            images = [];
            return planPhaseOf(capture);
        },
        execute: (sessionId) => run({ prompt: EXECUTE_PROMPT, images: [], sessionId, agent: "build" }, context),
    };
};

// A transport failure, read by class and code (isFetchNetworkFailure) since Node and Bun word it differently, names
// neither what was unreachable nor why: said as the local OpenCode server, which the next turn boots afresh (opencode.ts).
const unreachableServer = (error: unknown, provider: string): string | undefined => {
    const transport = isFetchNetworkFailure(error) || (error as { readonly reason?: unknown } | undefined)?.reason === "Transport";
    if (!transport) {
        return undefined;
    }
    const cause = (error as { readonly cause?: unknown }).cause;
    const said = cause instanceof Error ? cause.message : networkCodeOf(error);
    return `The local OpenCode server that runs ${openCodeBackendLabel(provider)} turns could not be reached${said === undefined ? "" : ` (${said})`}. Send again: it is restarted for the next turn.`;
};

// An error frame as the chat gets it: an uncoded one that is Google's NOT_FOUND names the model it refused.
const surfaced = (event: AgentEvent, provider: string, model: string | undefined): AgentEvent =>
    event.kind === "error" && event.code === undefined ? (googleRefusalFrame(provider, model, event.message) ?? event) : event;

// What a turn that threw says: the local server it could not reach, or its own words, a model-not-found coded as the
// event path codes it, so the client reloads the catalog and drops the bad pinned model.
const thrownFrame = (message: string, provider: string, model: string | undefined): AgentEvent =>
    googleRefusalFrame(provider, model, message) ?? {
        kind: "error",
        message,
        ...opt("code", isModelInvalid(message) ? ("grok-model-invalid" as const) : undefined),
    };

// How a turn's shell commands run (shell/opencode-shell.ts): in the conversation's tmux session where tmux-run is in the image,
// with the environment names the session's own environment adds to the daemon's forwarded into the pane (a pane starts
// from the tmux server's environment, not the session's); secrets through the turn's seam. The panel is told of a pane
// once per turn, whichever phase or subagent ran the first command.
const shellOf = (request: AgentRequest, env: Readonly<Record<string, string>> | undefined): TurnBase["shell"] => {
    const forward = Object.keys(env ?? {}).filter((key) => env?.[key] !== process.env[key]);
    const panes = tmuxRunEnabled();
    const shown = new Set<string>();
    return (sessionId, push) => {
        const pane = panes ? shellPaneOf(sessionId, forward, request.spec.conversationId) : undefined;
        return shellRouteOf({
            ...opt("secrets", request.tools.secrets),
            ...opt("pane", pane),
            surfaced: () => {
                if (pane !== undefined && !shown.has(pane.session)) {
                    shown.add(pane.session);
                    push({ kind: "terminal", session: pane.session });
                }
            },
        });
    };
};

// What every message of the turn shares, built once.
const turnBaseOf = async (
    request: AgentRequest,
    provider: string,
    gate: Pick<TurnBase, "gate" | "taint">,
    mounts: OpenCodeMounts,
): Promise<TurnBase> => {
    const env = request.policy.sealed === true ? undefined : await turnEnv(request);
    return {
        request,
        provider,
        ...gate,
        mounts,
        ...opt("env", env),
        ...opt("shell", request.policy.sealed === true ? undefined : shellOf(request, env)),
        // This run's one consumer of the steering queue; absent for a run with no queue.
        ...opt("steering", request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering)),
    };
};

// OpenCode's own plan agent proposes in its reply only, with no card of its own, so a plan turn is always the emulated
// one (plan-mode.ts), whatever modes the capability row honours for a turn that does not plan.
const PLANS_BY_EMULATION = { permissions: "plan" } as const;

// A provider's loop on OpenCode's `backend` provider; capability limits are declared in the contract's agent-catalog.ts.
// A hosted route's request names its own provider entry instead (opencode-routes.ts), so one loop serves them all.
export const createOpenCodeAgent = (runner: OpenCodeRunner, backend: string = OPENCODE_XAI_PROVIDER) =>
    async function* runOpenCodeAgent(request: AgentRequest<OpenCodeCredential>): AsyncGenerator<AgentEvent> {
        const provider = request.credential.kind === "opencode-route" ? request.credential.providerID : backend;
        // Pictures go to the model as pictures; everything else, including an unreadable picture, is named in the prompt
        // for the read tool.
        const attached = await loadAttachments(request.spec, true);
        const images: PromptFile[] = attached.images.map((image) => ({
            uri: `data:${image.mimeType};base64,${image.data}`,
            name: basename(image.path),
        }));
        const prompt = withFileNote(request.spec.prompt, [...attached.files, ...attached.unread]);
        // Turn's safety wiring (guard/turn-gate.ts): rulebook answered over OpenCode's permission channel, a hold parked
        // on a card while the runner holds its watchdog (the capability record says `rulebook: "approval"`). Releasing
        // the gate as the turn ends settles a card OpenCode moved on from (a refused sibling ask stops its session).
        const { gate, taint, release } = vendorTurnGate(request);
        // The turn's remote MCP servers, the same list Codex takes, mounted per phase by the runner.
        const mounts = openCodeMounts(request.spec.conversationId, request.tools.remote ?? []);
        const context: StreamContext = {
            view: { cwd: request.spec.cwd, toolName: mcpToolNameOf(mounts) },
            target: { provider, model: request.spec.model },
        };
        const base = await turnBaseOf(request, provider, { gate, taint }, mounts);
        const run = phaseRun(runner, base, openCodeTurnOf(base));
        const turn = planMode(
            PLANS_BY_EMULATION,
            request,
            () => openCodePlan(context, run, prompt, images),
            () => run({ prompt, images, sessionId: request.spec.sessionId, agent: "build" }, context),
        );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                surfacedError ||= event.kind === "error";
                yield surfaced(event, provider, request.spec.model);
            }
        } catch (error) {
            if (!surfacedError) {
                const message =
                    unreachableServer(error, provider) ?? (error instanceof Error ? error.message : `${openCodeBackendLabel(provider)} agent failed`);
                yield thrownFrame(message, provider, request.spec.model);
            }
        } finally {
            // This turn's outside-content bit and any card still open die with the turn (guard/turn-taint.ts).
            release();
            // A turn that never reached a phase (it failed first) still ends admission to its queue.
            request.spec.steering?.close();
        }
        yield { kind: "done" };
    };
