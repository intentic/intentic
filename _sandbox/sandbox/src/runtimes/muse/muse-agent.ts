import { whenAborted } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import { loadAttachments } from "../../agent/prompt/attachment-images.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import type { AgentRequest, MuseCredential } from "../../agent/providers/agent-request.js";
import { POST_PLAN_MODE } from "../../agent/run/agent.js";
import { vendorShellEnv } from "../../agent/run/vendor-shell-env.js";
import { opt } from "../../opt.js";
import { workloadStamp } from "../../seams/workload-stamp.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE, type PlanPhaseResult, planMode } from "../decorators/plan-mode.js";
import {
    DEFAULT_TURN_TIMEOUTS,
    EXPIRED,
    idleWait,
    SETTLED,
    type TurnTimeouts,
    type TurnWatchdog,
    turnWatchdog,
    watchedPull,
} from "../decorators/turn-watchdog.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { answerApproval, answerApprovalStage, answerQuestions, type MuseAsks, musePosture } from "./muse-asks.js";
import { MUSE_CLI_MISSING, museCli } from "./muse-cli.js";
import { type MuseHost, type MuseHostOpener, mspErrorKind, openMuseHost } from "./muse-host.js";
import { museEndpointConfigHome } from "./muse-settings.js";
import { museFailureFrame, museFrames, museStreamState, type MuseStreamState, museUsageFrame } from "./muse-stream.js";
import {
    AcceptedSchema,
    ModelListSchema,
    type MuseEvent,
    type MuseJson,
    readMuseEvent,
    SessionOpenedSchema,
    TurnStartedAnswerSchema,
} from "./muse-wire.js";

// Muse Code for the Services seam: AgentRequest in, AgentEvent frames out, over one `muse serve` host per turn speaking
// the Muse Session Protocol. The session lives in Muse's own store (durable host), so a later turn resumes it on a fresh
// host; the turn's MCP servers ride the session's own config, approvals and questions come back as cards, steering lands
// as turn/steer, and Muse's typed failures are coded for auto-resume.

type MuseRequest = AgentRequest<MuseCredential>;

// `--disable-sandbox`: the container (and an isolated turn's namespace) is the boundary, as Codex runs with full access;
// Muse's own sandbox would also cut the network to a proxy the daemon does not run. `--trust-workspace`: the workspace's
// AGENTS.md and rules load without a trust prompt nobody could answer, and nothing is saved by it.
const HOST_ARGS = ["--disable-sandbox", "--trust-workspace"] as const;

// Every session runs under `promptUnmatched`, so Muse asks about every shell command off its own allow rules and the
// owner's rulebook answers each (muse-asks.ts).
const APPROVAL_MODE = "promptUnmatched";

// Muse's built-in permission profiles: read-only for a planning phase, the ordinary one for everything else.
const READ_ONLY = ":read-only";
const ORDINARY = ":ask-me";

// After a stop, how long the host gets to settle the turn it was told to interrupt before it is closed regardless.
const ABORT_GRACE_MS = 5_000;

// The efforts Muse names, in its own spelling; a level outside it is dropped and the model's own default answers.
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// What a turn's env drops before Muse inherits it: keys only a turn that resolved one may carry, so a daemon-side
// bearer never reaches a turn on another account or endpoint.
const DROPPED_ENV = new Set(["META_API_KEY", "XDG_CONFIG_HOME"]);

// One item the loop's queue holds: a frame a card or a daemon tool pushed, a notification, or the host gone.
type Queued = { readonly kind: "frame"; readonly frame: AgentEvent } | { readonly kind: "event"; readonly event: MuseEvent } | { readonly kind: "exit"; readonly reason: string | undefined };

interface TurnLine {
    readonly queue: Queued[];
    readonly wait: ReturnType<typeof idleWait>;
    readonly push: (item: Queued) => void;
    exited: boolean;
}

const turnLine = (): TurnLine => {
    const line: TurnLine = {
        queue: [],
        wait: idleWait(),
        push: (item) => {
            line.queue.push(item);
            if (item.kind === "exit") {
                line.exited = true;
            }
            line.wait.wake();
        },
        exited: false,
    };
    return line;
};

// The turn's MCP servers as the session's own config: every remote mount (the daemon's door, mcp-kind cards) as a
// Streamable HTTP server. Optional, so one that will not start costs that server, not the session.
const mcpServersOf = (request: MuseRequest): Record<string, MuseJson> =>
    Object.fromEntries(
        (request.tools.remote ?? []).map((tool) => [
            tool.name,
            {
                transport: "streamableHttp",
                url: tool.url,
                mode: "optional",
                ...opt("headers", tool.token === undefined ? undefined : { Authorization: `Bearer ${tool.token}` }),
            },
        ]),
    );

const museEnv = async (request: MuseRequest): Promise<Record<string, string>> => {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !DROPPED_ENV.has(key)) {
            inherited[key] = value;
        }
    }
    // The owner stamp every turn workload carries; an unregistered turn (a bench run) has nobody to stamp.
    const stamp = request.spec.conversationId === undefined ? undefined : workloadStamp(request.spec.conversationId);
    const env = { ...inherited, ...request.tools.cliEnv, META_API_KEY: request.credential.apiKey, ...stamp };
    const endpoint = request.credential.endpoint;
    return {
        ...env,
        // Its shell's programs judged by the heavy table, as a Claude Code turn's are.
        ...(await vendorShellEnv(request.tools, env)),
        ...opt("XDG_CONFIG_HOME", endpoint === undefined ? undefined : await museEndpointConfigHome(endpoint)),
    };
};

interface MuseSession {
    readonly sessionId: string;
    readonly model: string | undefined;
    // The efforts Muse's model list says this model takes; absent where the list says nothing.
    readonly efforts?: readonly string[] | undefined;
    // Whether this host opened it fresh, which decides the profile it starts on.
    readonly fresh: boolean;
}

interface ServedModel {
    readonly model: string | undefined;
    readonly efforts?: readonly string[] | undefined;
}

// Muse's own list for the key it runs on (model/list): a pick it does not serve falls to its default, which the init
// frame then names. An endpoint's list is the one row its settings wrote, so it is not asked.
const servedModel = async (host: MuseHost, request: MuseRequest): Promise<ServedModel> => {
    const requested = request.credential.endpoint?.model ?? (request.spec.model === "" ? undefined : request.spec.model);
    if (request.credential.endpoint !== undefined) {
        return { model: requested };
    }
    // allow(silent-catch): a host that cannot list its models still serves the pick as asked; the turn's own failure says why.
    const list = await host.request("model/list", {}, ModelListSchema).catch(() => undefined);
    const row = list?.models.find((entry) => entry.modelId === requested) ?? list?.models.find((entry) => entry.isDefault) ?? list?.models[0];
    return row === undefined ? { model: requested } : { model: row.modelId, ...opt("efforts", Array.isArray(row.variants) ? row.variants : undefined) };
};

// Resumes the conversation's session where it has one Muse still holds; a session Muse has lost (another sandbox's,
// or one recorded by another loop) opens fresh rather than failing the turn.
const openSession = async (host: MuseHost, request: MuseRequest, readOnly: boolean): Promise<MuseSession> => {
    const config = { mcpServers: mcpServersOf(request) };
    const served = await servedModel(host, request);
    const model = served.model;
    if (request.spec.sessionId !== undefined && request.spec.sessionId !== "") {
        try {
            const resumed = await host.command("session/resume", { sessionId: request.spec.sessionId, excludeItems: true, config }, SessionOpenedSchema);
            if (model !== undefined && resumed.session.modelId !== model) {
                await host.command("session/setModel", { sessionId: resumed.session.sessionId, modelId: model }, AcceptedSchema);
            }
            return { sessionId: resumed.session.sessionId, model: model ?? resumed.session.modelId ?? undefined, efforts: served.efforts, fresh: false };
        } catch (error) {
            const kind = mspErrorKind(error);
            if (kind !== "sessionNotFound" && kind !== "invalidParams") {
                throw error;
            }
        }
    }
    const started = await host.command(
        "session/start",
        {
            workspaceRoot: request.spec.cwd,
            approvalMode: APPROVAL_MODE,
            config,
            ...opt("modelId", model),
            ...opt("permissionProfile", readOnly ? READ_ONLY : undefined),
        },
        SessionOpenedSchema,
    );
    return { sessionId: started.session.sessionId, model: started.session.modelId ?? model, efforts: served.efforts, fresh: true };
};

interface Phase {
    readonly prompt: string;
    readonly images: readonly { readonly mimeType: string; readonly data: string }[];
    readonly planning: boolean;
}

interface Run {
    readonly host: MuseHost;
    readonly request: MuseRequest;
    readonly session: MuseSession;
    readonly line: TurnLine;
    readonly clock: TurnWatchdog;
    readonly asks: Omit<MuseAsks, "posture">;
    readonly channel: (() => SteeringChannel) | undefined;
    // The permission profile the session stands on now, so a phase moves it only when it must.
    profile: string;
}

const inputOf = (text: string, images: Phase["images"]): MuseJson[] => [
    { type: "text", text },
    ...images.map((image) => ({ type: "image", mediaType: image.mimeType, base64Data: image.data })),
];

// Delivers the phase's steering queue into the running turn. A steer Muse refuses (the turn already ended) waits for the
// next turn of the same phase, so the message is delivered rather than dropped.
const pumpSteering = (run: Run, steering: AsyncIterable<string>, turn: () => string | undefined, later: string[]): void => {
    void (async () => {
        for await (const text of steering) {
            const running = turn();
            if (running === undefined) {
                later.push(text);
                continue;
            }
            await run.host
                .command("turn/steer", { sessionId: run.session.sessionId, expectedTurnId: running, input: [{ type: "text", text }] }, AcceptedSchema)
                .catch(() => later.push(text));
        }
    })();
};

const toolStarted = (event: MuseEvent): string | undefined =>
    event.method === "item/started" && event.params.item.kind === "toolCall" && event.params.item.status === "inProgress" ? event.params.item.itemId : undefined;

const toolFinished = (event: MuseEvent): string | undefined =>
    event.method === "item/completed" && event.params.item.kind === "toolCall" ? event.params.item.itemId : undefined;

// One notification's side effects beyond its frames: an approval or a question answered beside the stream (so the loop
// keeps reading while a card waits), and the watchdog held while a tool call runs, since a long build is Muse working,
// not Muse gone quiet.
const handleAsks = (run: Run, event: MuseEvent, posture: ReturnType<typeof musePosture>): void => {
    const asks: MuseAsks = { ...run.asks, posture };
    if (event.method === "approval/requested" && event.params.sessionId === run.session.sessionId) {
        void answerApproval(asks, event.params);
    } else if (event.method === "approval/updated" && event.params.sessionId === run.session.sessionId) {
        void answerApprovalStage(asks, event.params);
    } else if (event.method === "userInput/requested" && event.params.sessionId === run.session.sessionId) {
        void answerQuestions(asks, event.params);
    }
};

interface TurnEnd {
    readonly errored: boolean;
}

type Pulled = Queued | typeof SETTLED | typeof EXPIRED;

// Why the loop stopped reading before the turn's own terminal: a deadline, or the host gone. A stop the person asked for
// says nothing more; everything else says what happened, a silent host coded as an outage so auto-resume re-runs it.
const stopFrames = (run: Run, next: Pulled): AgentEvent[] => {
    if (run.request.signal.aborted) {
        return [];
    }
    if (next === EXPIRED) {
        return [{ kind: "error", code: "provider-outage", message: `Muse Code went quiet: ${run.clock.expiry()}. It was stopped; send again to carry on.` }];
    }
    const reason = next !== SETTLED && next.kind === "exit" ? next.reason : undefined;
    return [{ kind: "error", message: reason ?? "Muse Code exited mid-turn." }];
};

// The watchdog held while a tool call runs: a long build is Muse working, not Muse gone quiet.
const trackTools = (running: Map<string, () => void>, clock: TurnWatchdog, event: MuseEvent): void => {
    const opened = toolStarted(event);
    if (opened !== undefined && !running.has(opened)) {
        running.set(opened, clock.hold());
    }
    const closed = toolFinished(event);
    if (closed !== undefined) {
        running.get(closed)?.();
        running.delete(closed);
    }
};

interface Terminal {
    readonly frames: AgentEvent[];
    readonly end: TurnEnd;
}

// The turn's own terminal: what it spent, then its failure where it failed.
const terminalFrames = (state: MuseStreamState, event: Extract<MuseEvent, { method: "turn/completed" }>): Terminal => {
    const usage = museUsageFrame(state, event.params.durationMs);
    const frames = usage === undefined ? [] : [usage];
    if (event.params.terminal !== "failed") {
        return { frames, end: { errored: event.params.terminal !== "completed" } };
    }
    const error = event.params.error ?? { kind: "unknown", message: event.params.reason ?? "Muse Code's turn failed.", retryable: false };
    return { frames: [...frames, museFailureFrame(error, state.retried)], end: { errored: true } };
};

const startTurn = async (run: Run, text: string, images: Phase["images"]): Promise<string> => {
    // Forwarded where Muse names the tier and the model takes it; otherwise the model's own default answers.
    const requested = run.request.spec.effort;
    const offered = run.session.efforts === undefined || (requested !== undefined && run.session.efforts.includes(requested));
    const effort = requested !== undefined && EFFORTS.has(requested) && offered ? requested : undefined;
    const started = await run.host.command(
        "turn/start",
        { sessionId: run.session.sessionId, input: inputOf(text, images), ...opt("reasoningEffort", effort) },
        TurnStartedAnswerSchema,
    );
    return started.turnId;
};

// One turn/start and everything up to its terminal, its frames streamed as they arrive.
async function* runTurn(run: Run, text: string, images: Phase["images"], state: MuseStreamState, posture: ReturnType<typeof musePosture>): AsyncGenerator<AgentEvent, TurnEnd> {
    const turnId = await startTurn(run, text, images);
    state.turnId = turnId;
    const running = new Map<string, () => void>();
    const interrupt = (): void => {
        // allow(silent-catch): an interrupt refused is a turn already over; the deadline or the close ends it regardless.
        void run.host.command("turn/interrupt", { sessionId: run.session.sessionId, turnId }, AcceptedSchema).catch(() => undefined);
    };
    // A stop that came while the turn was being started is delivered now that there is a turn to stop.
    const unwatch = whenAborted(run.request.signal, interrupt);
    const pull = watchedPull({
        take: () => run.line.queue.shift(),
        settled: () => run.line.exited && run.line.queue.length === 0,
        clock: run.clock,
        wait: run.line.wait,
        until: () => (run.request.signal.aborted ? Date.now() + ABORT_GRACE_MS : undefined),
    });
    try {
        for (let next = await pull(); ; next = await pull()) {
            if (next === EXPIRED || next === SETTLED || next.kind === "exit") {
                interrupt();
                yield* stopFrames(run, next);
                return { errored: true };
            }
            if (next.kind === "frame") {
                yield next.frame;
                continue;
            }
            const event = next.event;
            trackTools(running, run.clock, event);
            handleAsks(run, event, posture);
            if (event.method === "turn/retryScheduled" && event.params.turnId === turnId) {
                // Muse is waiting out its own backoff: silence until then is not a hang.
                run.clock.extendPast(Date.now() + event.params.retryDelayMs);
            }
            yield* museFrames(event, { cwd: run.request.spec.cwd }, state);
            if (event.method === "turn/completed" && event.params.turnId === turnId) {
                const terminal = terminalFrames(state, event);
                yield* terminal.frames;
                return terminal.end;
            }
        }
    } finally {
        unwatch();
        for (const release of running.values()) {
            release();
        }
    }
}

// Moves the session onto the profile a phase needs; experimental on the wire, so a host that refuses it leaves the
// session where it is and the phase's approvals still answer by its posture.
const standOn = async (run: Run, profile: string): Promise<void> => {
    if (run.profile === profile) {
        return;
    }
    await run.host.command("session/setPermissionProfile", { sessionId: run.session.sessionId, profileId: profile }, AcceptedSchema);
    run.profile = profile;
};

// One phase: its turn, then a turn for each steer that arrived after the last one ended; returns what a plan needs.
async function* runPhase(run: Run, phase: Phase): AsyncGenerator<AgentEvent, PlanPhaseResult> {
    // allow(silent-catch): the profile switch is experimental on the wire; refused, the phase's posture still answers every approval.
    await standOn(run, phase.planning ? READ_ONLY : ORDINARY).catch(() => undefined);
    const posture = musePosture(run.request.policy.permissionMode, phase.planning);
    const state = museStreamState({ holdMessages: phase.planning });
    const steering = run.channel?.();
    const later: string[] = [];
    if (steering !== undefined) {
        pumpSteering(run, steering.steering, () => state.turnId, later);
    }
    let errored = false;
    try {
        let text = phase.prompt;
        let images = phase.images;
        for (;;) {
            const end = yield* runTurn(run, text, images, state, posture);
            errored ||= end.errored;
            state.turnId = undefined;
            const next = later.splice(0);
            if (end.errored || run.request.signal.aborted || next.length === 0) {
                break;
            }
            text = next.join("\n\n");
            images = [];
        }
    } finally {
        steering?.close();
    }
    return { sessionId: run.session.sessionId, planText: state.planText, errored };
}

// Muse honours every permission mode itself except the approval card between a plan and its execution, which the shared
// plan loop owns: this is that loop's view of Muse, not its capability row.
const PLAN_LOOP = { permissions: "plan" } as const;

export interface MuseAgentOptions {
    readonly open?: MuseHostOpener;
    readonly binary?: () => Promise<string | undefined>;
    readonly timeouts?: TurnTimeouts;
}

export const createMuseAgent = (options: MuseAgentOptions = {}) => {
    const open = options.open ?? openMuseHost;
    const binaryOf = options.binary ?? museCli;
    const timeouts = options.timeouts ?? DEFAULT_TURN_TIMEOUTS;
    return async function* runMuseAgent(request: MuseRequest): AsyncGenerator<AgentEvent> {
        const binary = await binaryOf();
        if (binary === undefined) {
            yield { kind: "error", message: MUSE_CLI_MISSING };
            yield { kind: "done" };
            return;
        }
        const planning = request.policy.permissionMode === "plan";
        const { gate, taint, release } = vendorTurnGate(request);
        const clock = turnWatchdog(timeouts);
        const line = turnLine();
        const pushFrame = (frame: AgentEvent): void => line.push({ kind: "frame", frame });
        const detach = request.hooks.relay?.attach({ push: pushFrame, hold: clock.hold, guard: { gate, taint } });
        const anchor = request.spec.isolation?.anchor;
        let host: MuseHost | undefined;
        try {
            host = await open({
                binary,
                args: HOST_ARGS,
                env: await museEnv(request),
                ...opt("namespace", anchor === undefined ? undefined : { pid: anchor.pid, cwd: anchor.cwd, ...opt("namespace", anchor.namespace) }),
                ...opt("spawnDepth", request.spec.spawnDepth),
            });
            const live = host;
            live.listen((notification) => {
                const event = readMuseEvent(notification);
                if (event !== undefined) {
                    line.push({ kind: "event", event });
                }
            });
            void live.exited.then((reason) => line.push({ kind: "exit", reason }));
            const session = await openSession(live, request, planning);
            yield { kind: "session", sessionId: session.sessionId };
            if (session.model !== undefined) {
                yield { kind: "init", model: session.model };
            }
            const run: Run = {
                host: live,
                request,
                session,
                line,
                clock,
                channel: request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering),
                profile: planning && session.fresh ? READ_ONLY : ORDINARY,
                asks: {
                    host: live,
                    sessionId: session.sessionId,
                    gate,
                    cards: request.hooks.cards,
                    conversationId: request.spec.conversationId,
                    signal: request.signal,
                    ...opt("restoredGrant", request.hooks.restoredGrant),
                    always: new Set(),
                    push: pushFrame,
                    hold: clock.hold,
                    verdicts: new Map(),
                },
            };
            const attached = await loadAttachments(request.spec, true);
            const prompt = withFileNote(request.spec.prompt, [...attached.files, ...attached.unread]);
            yield* planMode(
                PLAN_LOOP,
                request,
                () => ({
                    prompt: PLAN_PREAMBLE + withFileNote(request.spec.prompt, [...attached.files, ...attached.pictures]),
                    plan: (planPrompt) => runPhase(run, { prompt: planPrompt, images: [], planning: true }),
                    async *execute() {
                        // Moves the mode as the Claude loop's approval does, so the composer's chip follows the turn out of planning.
                        yield { kind: "mode", mode: POST_PLAN_MODE };
                        return yield* runPhase(run, { prompt: EXECUTE_PROMPT, images: [], planning: false });
                    },
                }),
                () => runPhase(run, { prompt, images: attached.images, planning: false }),
            );
        } catch (error) {
            if (!request.signal.aborted) {
                yield { kind: "error", message: `Muse Code: ${errorMessage(error)}` };
            }
        } finally {
            detach?.();
            // allow(silent-catch): the turn is over; a host that will not close cleanly is killed by close's own escalation.
            await host?.close().catch(() => undefined);
            release();
        }
        // Frames a card pushed after the last pull (its resolution) still belong to this turn.
        for (const item of line.queue.splice(0)) {
            if (item.kind === "frame") {
                yield item.frame;
            }
        }
        yield { kind: "done" };
    };
};

