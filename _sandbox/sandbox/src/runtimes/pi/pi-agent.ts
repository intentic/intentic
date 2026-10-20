import type { AcpAgentConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { PI } from "@intentic/sandbox-contract/models/agent-runtimes";
import { whenAborted, withDeadline } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { imageBlock } from "../../agent/prompt/attachment-images.js";
import {
    DEFAULT_TURN_TIMEOUTS,
    EXPIRED,
    idleWait,
    type IdleWait,
    SETTLED,
    type TurnTimeouts,
    type TurnWatchdog,
    turnWatchdog,
    watchedPull,
    withTurnCap,
} from "../decorators/turn-watchdog.js";
import { handoffDirOf } from "../../conversations/worktrees/isolation.js";
import { tmuxRunEnabled } from "../../agent/tools/agent-terminals.js";
import { turnCheckReports, turnChecksNote, turnChecksNotice } from "../../agent/run/turn-checks.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import { opt } from "../../opt.js";
import { withStderrTail } from "../decorators/vendor-errors.js";
import { textPlanTurn, vendorTurn } from "../decorators/vendor-turn.js";
import { createPiEventMapper } from "./pi-events.js";
import { answerExtensionUi, type PiDialog } from "./pi-extension-ui.js";
import { createPiHooks, type PiHooks } from "./pi-hooks.js";
import type { PiEvent, PiLaunch, PiProcess, PiResponse, PiSpawn, PiStarted } from "./pi-rpc.js";

// Pi provider adapter (same seam as runAgent/createCodexAgent/createOpenCodeAgent/runAcpAgent): AgentRequest in, AgentEvent
// frames out, over Pi's RPC. One process per turn (Pi persists sessions as files; resume is `switch_session` on a fresh
// process); the session id on the wire is the session file path, which is also what holdsSession checks. Above the ACP
// floor it forwards steering onto Pi's `steer` queue and effort onto `set_thinking_level`, and starts each process with
// the turn's instructions, skills, namespace and MCP servers (pi-rpc.ts PiLaunch). The daemon's extension puts every
// tool call and result to the turn's hook socket (pi-hooks.ts): the owner's rules and the turn's tool list before a call
// runs, a shell line through the terminal panel with its secrets resolved, every result masked and sealed after. The
// repositories' `turn` checks run once as the turn is about to end, and what they found goes back to Pi as one more
// prompt, as the Claude Code loop's Stop hook says it.

// What the turn's planner decided for Pi beyond the request: the skill folders it loads, as the process sees them, and
// the daemon's own servers among its MCP mounts, whose results the door already sealed.
export interface PiTurnOptions {
    readonly skills?: readonly string[];
    readonly sealedAtDoor?: readonly string[];
}

// Said when the turn carried MCP servers its Pi cannot mount: a Pi older than its built-in MCP (upstream 0.99).
const mcpUnmounted = (started: Partial<PiStarted>, count: number): AgentEvent => ({
    kind: "agent_notice",
    level: "warning",
    text:
        `This Pi${started.version === undefined ? "" : ` (${started.version})`} has no built-in MCP, so this turn's ${String(count)} MCP ` +
        `server${count === 1 ? " was" : "s were"} not mounted. Pi 0.99 or later mounts them.`,
});

// The launch a turn's process starts with: its instructions (agent-request.ts systemPrompt replaces Pi's base,
// systemAppend adds to it), its skills, its MCP servers, and an anchored turn's namespace.
const launchOf = (request: AgentRequest, options: PiTurnOptions, hooks: PiHooks): PiLaunch => {
    const anchor = request.spec.isolation?.anchor;
    return {
        hooks: hooks.endpoints,
        cwd: request.spec.cwd,
        ...opt("owner", request.spec.conversationId),
        ...opt("spawnDepth", request.spec.spawnDepth),
        instructions: { ...opt("replace", request.spec.systemPrompt), ...opt("append", request.spec.systemAppend) },
        ...opt("skills", options.skills),
        ...opt("tools", request.tools.remote),
        ...opt(
            "anchor",
            anchor === undefined ? undefined : { pid: anchor.pid, cwd: anchor.cwd, ...opt("namespace", anchor.namespace), ...opt("handoff", handoffDirOf(anchor)) },
        ),
    };
};

// Setup commands (switch_session/get_state/set_model/…) answer immediately or the process is not speaking the protocol,
// same hard-race reasoning as ACP's initialize guard.
const SETUP_TIMEOUT_MS = 15_000;

// A command as the transport takes it.
type PiCommand = Parameters<PiProcess["request"]>[0];

// One setup command under that deadline. The deadline ends the request, not only the wait: its id is forgotten, so a late
// answer is dropped. Pi has no per-command cancel, so the command may still land on its side, which these can afford: a
// switch, state read or model pin that times out fails the turn, and the turn's end kills the process; a thinking level
// that lands late is still the one asked for; the rest only read.
const setup = (proc: PiProcess, command: PiCommand): Promise<PiResponse> =>
    withDeadline((signal) => proc.request(command, signal), SETUP_TIMEOUT_MS);

// How long a turn waits for Pi to settle after an abort was sent, before the process is killed outright.
const ABORT_GRACE_MS = 5_000;

// How long a turn waits, once Pi answers its setup, for the daemon's extension to say its hooks are in place. It says so
// as Pi loads it, before Pi answers anything, so this only runs out on a Pi that never loaded it.
const HOOKS_READY_MS = 10_000;

const UNHOOKED =
    "Pi did not load the sandbox's extension, so nothing could check its tools against your owner's rules and the turn did not start. " +
    "Check that the installed Pi takes extensions (`-e`), then send again.";

// A frame a daemon tool or the turn's hooks raised (a card, its resolution, the terminal panel), queued beside Pi's own
// events so it reaches the stream the client reads in the order it happened.
class Relayed {
    constructor(readonly frame: AgentEvent) {}
}

// The per-process event plumbing the turn loop drains: pushed by the transport's handler, pulled by runPiTurn under the
// turn's deadlines (the acp-agent pattern).
interface PiTurnState {
    readonly queue: (PiEvent | Relayed)[];
    exited: boolean;
    exitCode: number | null;
    readonly wait: IdleWait;
    // The running prompt's watchdog: what a card the daemon raises holds while a person answers. Absent between prompts,
    // when no tool runs.
    clock?: Pick<TurnWatchdog, "hold"> | undefined;
}

// How one prompt turn ended: whether anything failed, and, on a `holdText` turn, the text it held back instead of
// streaming, the plan the user is about to be asked to approve.
interface PiTurnOutcome {
    readonly errored: boolean;
    readonly planText?: string;
}

// A dialog parks on its card with the turn's clock held: the turn is waiting on a person, not on Pi.
async function* askHeld(dialog: PiDialog | undefined, hold: () => () => void): AsyncGenerator<AgentEvent> {
    if (dialog === undefined) {
        return;
    }
    const release = hold();
    try {
        yield* dialog.ask();
    } finally {
        release();
    }
}

// Sends the prompt and waits for Pi to accept it, like a setup command, though a stop ends the wait too. Answers whether
// the turn goes on; when it does not, it has said why, unless the turn was stopped. No answer is not a refusal: the prompt
// may already be on Pi's stdin, and Pi starts its run once the prompt's preflight (auth, a compaction, an extension's
// hooks) is through, which its `abort` cannot reach, since until then there is no run to abort. Killing the process is
// the one way to be sure no run starts that nobody is reading; the session file survives it, so the next send resumes. A
// turn stopped before this point never writes the prompt at all.
async function* sendPrompt(proc: PiProcess, stop: AbortSignal, prompt: PiCommand, abort: () => void): AsyncGenerator<AgentEvent, boolean> {
    let accepted: PiResponse;
    try {
        accepted = await withDeadline((signal) => proc.request(prompt, signal), SETUP_TIMEOUT_MS, { signal: stop });
    } catch {
        abort();
        proc.kill();
        if (!stop.aborted) {
            yield {
                kind: "error",
                message: withStderrTail(`Pi did not answer the prompt within ${SETUP_TIMEOUT_MS / 1000}s. It was stopped; send again to retry.`, proc.stderrTail()),
            };
        }
        return false;
    }
    if (!accepted.success) {
        yield { kind: "error", message: withStderrTail(`Pi rejected the prompt: ${accepted.error ?? "unknown error"}`, proc.stderrTail()) };
        return false;
    }
    return true;
}

// One item off the turn's queue as frames: a frame the daemon relayed as it is, an extension's UI answered (what it shows
// streams as frames, and a dialog parks on a card with the clock held, since the turn is waiting on a person rather
// than on Pi; pi-extension-ui.ts), Pi's own events mapped. Answers true once Pi said the run settled.
async function* streamed(
    next: PiEvent | Relayed,
    proc: PiProcess,
    request: AgentRequest,
    mapper: ReturnType<typeof createPiEventMapper>,
    hold: () => () => void,
): AsyncGenerator<AgentEvent, boolean> {
    if (next instanceof Relayed) {
        yield next.frame;
        return false;
    }
    if (next.type === "extension_ui_request") {
        const answer = answerExtensionUi(proc, next, { cards: request.hooks.cards, conversationId: request.spec.conversationId, signal: request.signal });
        yield* answer.frames;
        yield* askHeld(answer.dialog, hold);
        return false;
    }
    if (next.type !== "agent_settled") {
        yield* mapper.map(next);
        return false;
    }
    const usage = mapper.usage();
    if (usage !== undefined) {
        yield usage;
    }
    return true;
}

// One prompt turn on the warm process: send the prompt, stream mapped events until agent_settled (or a watchdog fires,
// or the process dies). Does NOT emit the terminal `done`, the caller does once the whole turn settles.
async function* runPiTurn(
    proc: PiProcess,
    state: PiTurnState,
    request: AgentRequest,
    prompt: Record<string, unknown>,
    timeouts: TurnTimeouts,
    holdText = false,
): AsyncGenerator<AgentEvent, PiTurnOutcome> {
    const mapper = createPiEventMapper(request.spec.cwd, holdText);
    // The verdict folds in what the mapper held back: accumulated plan text, and whether an error frame already went
    // out (a failure even if the turn itself settled cleanly).
    const settled = (errored: boolean): PiTurnOutcome => {
        const captured = mapper.capture();
        return {
            errored: errored || captured.errored === true,
            ...(captured.planText !== undefined ? { planText: captured.planText } : {}),
        };
    };

    let abortSent = false;
    const sendAbort = (): void => {
        if (!abortSent) {
            abortSent = true;
            void proc.request({ type: "abort" });
        }
    };
    // The process is spawned before this point, so a turn stopped during spawn arrives already aborted; a bare listener
    // would never fire, and Pi would never be told.
    const unwatchAbort = whenAborted(request.signal, sendAbort);

    try {
        if (!(yield* sendPrompt(proc, request.signal, prompt, sendAbort))) {
            return settled(true);
        }

        const clock = turnWatchdog(withTurnCap(timeouts, request.spec.turnCapMs));
        state.clock = clock;
        const pull = watchedPull({
            take: () => state.queue.shift(),
            settled: () => state.exited,
            clock,
            wait: state.wait,
            // An abort narrows the wait to a grace window: Pi usually settles the run, but a wedged provider call may
            // never, and the user has already asked for their turn back.
            until: () => (request.signal.aborted ? Date.now() + ABORT_GRACE_MS : undefined),
        });
        for (let next = await pull(); next !== EXPIRED; next = await pull()) {
            if (next === SETTLED) {
                if (request.signal.aborted) {
                    // The user stopped the turn and the process went down with it, that is the stop working.
                    return settled(true);
                }
                yield { kind: "error", message: withStderrTail(`Pi exited mid-turn (code ${state.exitCode ?? "?"})`, proc.stderrTail()) };
                return settled(true);
            }
            if (yield* streamed(next, proc, request, mapper, clock.hold)) {
                return settled(false);
            }
        }
        if (request.signal.aborted) {
            proc.kill();
            return settled(true);
        }
        // Watchdog: Pi went silent (or ran forever). The kill is what guarantees the turn ends; the session file survives
        // it, so the next send resumes the conversation.
        sendAbort();
        proc.kill();
        yield { kind: "error", message: `Pi timed out: ${clock.expiry()}. It was stopped; send again to retry.`, own: true };
        return settled(true);
    } finally {
        state.clock = undefined;
        unwatchAbort();
    }
}

// Pi's extension/skill/template commands, for the composer's `/` popover; invoking one is plain `/name …` prompt text
// (the get_commands contract). Best-effort: an empty list is not an error.
async function* publishedCommands(proc: PiProcess): AsyncGenerator<AgentEvent> {
    const commands = await setup(proc, { type: "get_commands" }).catch(() => undefined);
    const items = (commands?.data as { commands?: { name?: unknown; description?: unknown }[] } | undefined)?.commands;
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }
    const mapped: AgentCommand[] = items
        .filter((entry) => typeof entry.name === "string")
        .map((entry) => ({ name: entry.name as string, description: typeof entry.description === "string" ? entry.description : "" }));
    if (mapped.length > 0) {
        yield { kind: "commands", items: mapped };
    }
}

// Context-window fill for the conversation, read once the turn settles. Pi's own estimate, the same number its footer
// shows. Best-effort: a killed process simply reports nothing.
async function* contextUsage(proc: PiProcess): AsyncGenerator<AgentEvent> {
    const stats = await setup(proc, { type: "get_session_stats" }).catch(() => undefined);
    const context = (stats?.data as { contextUsage?: { tokens?: unknown; contextWindow?: unknown } } | undefined)?.contextUsage;
    if (typeof context?.tokens === "number" && typeof context.contextWindow === "number" && context.contextWindow > 0) {
        yield { kind: "context_usage", tokens: context.tokens, contextWindow: context.contextWindow };
    }
}

// Forwards the turn's steering queue onto Pi's own steer queue, the real mid-turn injection the capability record
// claims. A steer that lands while Pi is momentarily idle (between plan phases) is refused by the protocol; it retries
// as a follow_up so the message is delivered rather than dropped.
const pumpSteering = (proc: PiProcess, request: AgentRequest): void => {
    const steering = request.spec.steering;
    if (steering === undefined) {
        return;
    }
    void (async () => {
        for await (const text of steering) {
            const steered = await proc.request({ type: "steer", message: text });
            if (!steered.success) {
                await proc.request({ type: "follow_up", message: text });
            }
        }
    })();
};

// Waits for the daemon's extension to say its hooks are in place: a Pi that never does would run its tools past the
// owner's rules and the turn's tool list, so the turn ends here instead, saying why. A stopped turn says nothing.
async function* hooksReady(hooks: PiHooks, proc: PiProcess, stop: AbortSignal): AsyncGenerator<AgentEvent, boolean> {
    const ready = await withDeadline(() => hooks.ready, HOOKS_READY_MS, { signal: stop }).then(
        () => true,
        () => false,
    );
    if (!ready && !stop.aborted) {
        yield { kind: "error", message: withStderrTail(UNHOOKED, proc.stderrTail()) };
    }
    return ready;
}

// The repositories' `turn` checks, once, as the turn is about to end (turn-checks.ts): what they found goes back to Pi as
// one more prompt, which it fixes or answers, as the Claude Code loop's Stop hook says it. Bound only to a turn in its
// own worktree (harness-hooks.ts turnChecksOf), and never run on one that failed or was stopped. Nothing waits on them
// past that one prompt.
async function* endingChecks(proc: PiProcess, state: PiTurnState, request: AgentRequest, timeouts: TurnTimeouts): AsyncGenerator<AgentEvent> {
    const checks = request.hooks.turnChecks;
    if (checks === undefined || checks.rules.length === 0 || request.signal.aborted) {
        return;
    }
    let note: string | undefined;
    let notice: AgentEvent | undefined;
    try {
        const reports = await turnCheckReports(checks);
        note = reports.length === 0 ? undefined : turnChecksNote(reports);
        notice = reports.length === 0 ? undefined : turnChecksNotice(reports);
    } catch (error) {
        // Never a failed turn: a check that cannot be run is no reason to keep the turn from ending.
        checks.logger.warn({ err: error }, "turn checks: could not run the repositories' turn checks, so the turn ends without them");
        return;
    }
    if (note !== undefined) {
        // The boundary the report is read from (turn-runs.ts closingOf): what Pi says next answers the checks.
        if (notice !== undefined) {
            yield notice;
        }
        yield* runPiTurn(proc, state, request, { type: "prompt", message: note }, timeouts);
    }
}

// Builds the Pi provider for the Services seam. `config` comes from the turn's resolved `pi` capability (planPiTurn); a
// spawn failure surfaces as an error frame, then done.
export const createPiAgent = (spawnPi: PiSpawn, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS) =>
    async function* runPiAgent(config: AcpAgentConfig, request: AgentRequest<ContainerCredential>, options: PiTurnOptions = {}): AsyncGenerator<AgentEvent> {
        const state: PiTurnState = { queue: [], exited: false, exitCode: null, wait: idleWait() };
        const hooks = createPiHooks(request, { tmux: tmuxRunEnabled(), sealedAtDoor: new Set(options.sealedAtDoor ?? []) });
        // Where the daemon's own frames enter the turn: its queue, beside Pi's events.
        const relayed = (event: AgentEvent): void => {
            state.queue.push(new Relayed(event));
            state.wait.wake();
        };
        // The running prompt's watchdog, held while a card waits on a person; between prompts nothing runs to hold it.
        const hold = (): (() => void) => state.clock?.hold() ?? (() => undefined);

        // The turn body as its own generator, so an early return (a dead session, a rejected pin) still reaches the one `done`.
        async function* turn(proc: PiProcess & Partial<PiStarted>): AsyncGenerator<AgentEvent> {
            const servers = request.tools.remote?.length ?? 0;
            if (servers > 0 && proc.mcpMounted !== true) {
                yield mcpUnmounted(proc, servers);
            }
            // Resume: the recorded session id is the Pi session file the last turn reported. A file Pi no longer
            // accepts is the coded self-heal every runtime shares: the client drops the id and the next send starts
            // fresh.
            if (request.spec.sessionId !== undefined) {
                const switched = await setup(proc, { type: "switch_session", sessionPath: request.spec.sessionId });
                if (!switched.success) {
                    yield {
                        kind: "error",
                        code: "session-not-found",
                        message: "Pi no longer has this chat's session. Send again to start fresh.",
                    };
                    return;
                }
            }
            const stateResponse = await setup(proc, { type: "get_state" });
            const sessionFile = (stateResponse.data as { sessionFile?: unknown } | undefined)?.sessionFile;
            if (typeof sessionFile === "string" && sessionFile !== "") {
                hooks.session(sessionFile);
                yield { kind: "session", sessionId: sessionFile };
            }
            if (!(yield* hooksReady(hooks, proc, request.signal))) {
                return;
            }
            // A pinned model reaches Pi as `provider/model-id` (its own `--model` spelling); no picker offers one, so
            // it only arrives deliberately (an automation config), and a rejected pin fails the turn honestly.
            if (request.spec.model !== undefined && request.spec.model !== "") {
                const slash = request.spec.model.indexOf("/");
                const picked =
                    slash > 0
                        ? await setup(proc, { type: "set_model", provider: request.spec.model.slice(0, slash), modelId: request.spec.model.slice(slash + 1) })
                        : { success: false, error: `expected provider/model-id, got "${request.spec.model}"` };
                if (!picked.success) {
                    yield { kind: "error", message: `Pi could not use the model "${request.spec.model}": ${picked.error ?? "unknown error"}` };
                    return;
                }
            }
            // Effort rides Pi's own thinking scale (shares the wire's tier names); a tier the model doesn't offer is
            // refused by Pi and tolerated, since reasoning depth is advisory.
            if (request.spec.effort !== undefined) {
                await setup(proc, { type: "set_thinking_level", level: request.spec.effort }).catch(() => undefined);
            }
            yield* publishedCommands(proc);

            pumpSteering(proc, request);

            // Raster attachments ride the prompt as native Pi ImageContent blocks; unreadable files degrade to a path note.
            // Pi resumes by the session file it reported, so a phase's own session id goes unread.
            const last = { errored: false };
            yield* textPlanTurn(PI, request, true, async function* (text, images, _sessionId, planning) {
                const message = { type: "prompt", message: text, ...(images.length > 0 ? { images: images.map(imageBlock) } : {}) };
                const outcome = yield* runPiTurn(proc, state, request, message, timeouts, planning);
                last.errored = outcome.errored;
                return { sessionId: typeof sessionFile === "string" ? sessionFile : undefined, planText: outcome.planText, errored: outcome.errored };
            });
            if (!last.errored) {
                yield* endingChecks(proc, state, request, timeouts);
            }

            yield* contextUsage(proc);
        }

        // The loop's half of the turn's hooks and of the daemon's own tools (pi-hooks.ts, turn-relay.ts): its gate, the
        // gate's taint bit, its stream and its watchdog, for as long as the turn runs. A frame raised after the last
        // prompt settled still reaches the stream.
        async function* serve(proc: PiProcess & Partial<PiStarted>, gate: CommandGuard, taint: TurnTaint): AsyncGenerator<AgentEvent> {
            const detachHooks = hooks.attach({ gate, taint, push: relayed, hold });
            const detachRelay = request.hooks.relay?.attach({ push: relayed, hold, guard: { gate, taint } });
            try {
                yield* turn(proc);
                for (const item of state.queue.splice(0)) {
                    if (item instanceof Relayed) {
                        yield item.frame;
                    }
                }
            } finally {
                detachRelay?.();
                detachHooks();
            }
        }

        yield* vendorTurn(request, {
            open: () =>
                spawnPi(config, launchOf(request, options, hooks), {
                    onEvent: (event) => {
                        state.queue.push(event);
                        state.wait.wake();
                    },
                    onExit: (code) => {
                        state.exited = true;
                        state.exitCode = code;
                        state.wait.wake();
                    },
                }),
            unopened: "Pi failed to start",
            // A throwing setup (switch_session timeout, a dead transport), with Pi's own stderr folded in.
            failure: (error, proc) => withStderrTail(error instanceof Error ? error.message : "Pi agent failed", proc.stderrTail()),
            close: (proc) => proc.kill(),
            serve,
        });
    };
