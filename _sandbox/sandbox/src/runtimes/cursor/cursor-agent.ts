import { vendorShellEnv } from "../../agent/run/vendor-shell-env.js";
import { join } from "node:path";
import type { AgentOptions, McpServerConfig as CursorMcpServer, ModelSelection, SendOptions } from "@cursor/sdk";
import { type AgentEvent, CURSOR } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { whenAborted } from "@intentic/base/async";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import type { AgentRequest, CursorCredential } from "../../agent/providers/agent-request.js";
import { EventQueue } from "../../agent/run/event-queue.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import type { CursorCatalog } from "./models/cursor-catalog.js";
import { createCursorEventMapper } from "./cursor-events.js";
import { type CursorRunHandle, type CursorSession, inProcessHost, namespacedHost, type NamespacedHostInput } from "./cursor-host.js";
import type { CursorHookService } from "./cursor-hooks.js";
import { opt } from "../../opt.js";
import { selectionFor } from "./models/cursor-models.js";
import { CURSOR_SDK_MISSING, cursorSdk, cursorSdkEntry } from "./cursor-sdk.js";
import { cursorCustomTools, cursorMcpServers, TOOLS_WITHHELD } from "./cursor-tools.js";
import type { TurnShield } from "../../privacy/privacy-shield.js";
import {
    CURSOR_SHIELD_NOTE,
    createEventRestorer,
    cursorHookShield,
    instructionRefusal,
    SHIELD_WITHHELD,
    shieldedCustomTools,
} from "./cursor-shield.js";

// Cursor provider adapter: same AgentRequest-in/AgentEvent-out seam as createCodexAgent/createOpenCodeAgent/runPiAgent,
// over @cursor/sdk's local agent runtime. The loop runs in this process, so the daemon's own functions can be tools; the
// SDK agent itself runs here too, except for a turn anchored in a mount namespace, whose agent runs in a runtime process
// born there (cursor-host.ts) and reaches those same tools back over its channel. Reads only the delta stream from
// `send({ onDelta })`, not the overlapping `run.stream()`.

export interface CursorAgentDeps {
    readonly catalog: CursorCatalog;
    readonly hooks: CursorHookService;
    readonly logger: Logger;
    // How an anchored turn's runtime process is started; a suite stands in for the process here.
    readonly runtime?: Pick<NamespacedHostInput, "spawn" | "command">;
}

// Grace period for a cancel to unwind Cursor's tool calls before frames stop; a request, not a kill.
const CANCEL_GRACE_MS = 5_000;

// How long a phase waits for its first delta before calling the run stalled. Bounds the opening only: once deltas flow,
// a silent gap is a tool call running long, and a cap there would end working turns.
export const FIRST_DELTA_MS = 5 * 60_000;

// Coded like a 5xx so the outage breaker queues the turn and resumes it on its own session, rather than stranding it.
const CURSOR_STALLED = "Cursor took the turn and then sent nothing at all; treating the provider as unavailable.";

// Maps everything the SDK can throw to the coded error frames auto-resume/reconnect already key off, matched by the
// SDK's exported error classes, not message text (which is not public API).
const codedError = async (error: unknown, sdk: Awaited<ReturnType<typeof cursorSdk>>): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const message = error instanceof Error && error.message !== "" ? error.message : "The Cursor turn failed.";
    if (sdk === undefined) {
        return { kind: "error", message };
    }
    if (error instanceof sdk.RateLimitError) {
        return { kind: "error", message, code: "rate_limit" };
    }
    if (error instanceof sdk.AuthenticationError) {
        // Not subscription-required: account is connected, the key stopped working; fix is re-signing the same row.
        return { kind: "error", message: `${message} Connect your Cursor account again in Sandbox ▸ Agent.` };
    }
    if (error instanceof sdk.AgentBusyError) {
        return { kind: "error", message, code: "agent-busy" };
    }
    if (error instanceof sdk.AgentNotFoundError) {
        // This machine lost the named agent (store cleared, a rebuild); client drops it, next send opens fresh.
        return { kind: "error", message, code: "session-not-found" };
    }
    // UnknownAgentError is deliberately not matched above: it is the SDK's catch-all for any error it cannot classify
    // (its converter ends in `new UnknownAgentError(message)`), not "unknown agent". Coding it session-not-found hid
    // real failures as a silently dropped session, the wedged "already has active run" among them.
    if (error instanceof sdk.NetworkError) {
        return { kind: "error", message, code: "provider-outage" };
    }
    return { kind: "error", message };
};

// A sealed request's agent (agent-request.ts `policy.sealed`): its prompt is everything the model reads, so no tool is
// offered, no MCP server or custom tool mounted, and no setting source read, the command gate's included, since nothing
// can run for it to gate. An empty allowlist rather than a denylist: an unknown tool name in disallowedTools makes
// Agent.create reject outright.
const sealedOptions = (model: ModelSelection, apiKey: string, cwd: string): AgentOptions => ({
    model,
    apiKey,
    tools: [],
    local: { cwd, settingSources: [] },
});

// Ends one phase's drain without ending the turn's queue: a plan turn runs two phases, and the tools that push into it
// were bound to it once, when the agent was created.
const PHASE_END = Symbol("cursor-phase-end");
type PhaseItem = AgentEvent | typeof PHASE_END;

// Cursor's `plan` mode is read-only by the runtime's own enforcement; `agent` is the full toolbox. Every other posture
// this repo asks for collapses onto `agent`: finer approvals are the command rulebook's job, not a mode.
const modeFor = (planning: boolean): "plan" | "agent" => (planning ? "plan" : "agent");

// Mid-turn injection rides the live Run, not the prompt, so the pump waits for the handle `send` resolves rather than
// racing it. Only `complete_delivered` transfers ownership. Any other answer (`revert_to_followup`, a refused steer, a
// run with no `steer` at all) hands the message back, and the relay has already let it go, so the pump keeps it and the
// phase sends it as an ordinary follow-up once the run settles: the SDK's own instruction, and what Codex does with a
// steer its app-server refuses. `Run.steer` is declared optional by the SDK, so CursorRunHandle carries it optionally
// too.

// Best-effort: the phase ends on its own timer, so a cancel the SDK refuses is only worth a trace.
const cancelRun = async (started: Promise<CursorRunHandle | undefined>, logger: Logger): Promise<void> => {
    const handle = await started;
    try {
        await handle?.cancel();
    } catch (error) {
        logger.debug({ err: error }, "cursor: run cancel refused");
    }
};

// Answers, once the channel closes, every message the run handed back, in the order they were typed.
const steerInto = async (
    started: Promise<CursorRunHandle | undefined>,
    channel: SteeringChannel,
    settled: () => boolean,
    logger: Logger,
    // The words as the run may read them: masked while the privacy shield reads the turn. Words it could not mask are
    // handed back rather than steered, and the follow-up they become is masked again before it is sent.
    prepare: (text: string) => Promise<string>,
): Promise<readonly string[]> => {
    const handedBack: string[] = [];
    for await (const text of channel.steering) {
        const run = await started;
        const sent = await prepare(text).catch((error: unknown) => {
            logger.warn({ err: error }, "cursor: a steering message could not be masked, handing it back");
            return undefined;
        });
        // A run that has already settled can take nothing, so it is not asked.
        const outcome =
            settled() || sent === undefined
                ? undefined
                : await run?.steer?.(sent).catch((error: unknown) => {
                      logger.warn({ err: error }, "cursor: steering message rejected by the run");
                      return undefined;
                  });
        if (outcome !== "complete_delivered") {
            handedBack.push(text);
        }
    }
    return handedBack;
};

// Said when the shield reads a turn but its hooks into Cursor are not in place (cursor-hooks.ts could not write the
// hooks file, or another daemon took it): with no hook in front of a read, a turn would run unread past its prompt.
const CURSOR_HOOKS_MISSING =
    "The privacy shield could not read this turn: its hooks into Cursor are not installed in this sandbox, so Cursor's file reads and commands would go to Cursor unchecked. Restart the sandbox to reinstall them, or let Cursor read this conversation as it is.";

// A shielded turn's opening (cursor-shield.ts): refused when the shield's hooks are not in place, or when the rules
// Cursor loads itself hold personal data; otherwise the prompt and the instructions as the model may read them, masked
// while the shield masks, with the note that tells the model what a token is and where its tools stand.
const shieldedStart = async (
    shield: TurnShield,
    request: AgentRequest<CursorCredential>,
    anchor: { readonly pid: number } | undefined,
    words: string,
    attachments: readonly string[],
): Promise<{ readonly refused: Extract<AgentEvent, { kind: "error" }> } | { readonly prompt: string; readonly append: string | undefined; readonly masking: boolean }> => {
    try {
        // An anchored turn's folder as its namespace sees it, which is the tree Cursor's own rule loader reads.
        const root = anchor === undefined ? request.spec.cwd : join("/proc", String(anchor.pid), "root", request.spec.cwd);
        const instructions = await instructionRefusal(shield, root, "Cursor");
        if (instructions !== undefined) {
            return { refused: { kind: "error", code: "privacy-instructions", message: instructions } };
        }
        const masking = await shield.masking();
        const prompt = await shield.mask(withFileNote(words, attachments), "prompt");
        const own = request.spec.systemAppend === undefined || request.spec.systemAppend === "" ? undefined : await shield.mask(request.spec.systemAppend, "instructions");
        const append = masking ? (own === undefined ? CURSOR_SHIELD_NOTE : `${own}\n\n${CURSOR_SHIELD_NOTE}`) : own;
        return { prompt, append, masking };
    } catch (error) {
        const message = `The privacy shield could not read this turn, so it was not sent to Cursor. ${error instanceof Error ? error.message : ""}`.trim();
        return { refused: { kind: "error", code: "privacy-unshielded", message } };
    }
};

// Every MCP server the turn mounts, reached through the privacy shield's masking proxy instead (gateway/mcp-route.ts);
// its own headers ride along, so the server sees the bearer it always did.
const proxiedMcpServers = async (servers: Record<string, CursorMcpServer>, shield: TurnShield): Promise<Record<string, CursorMcpServer>> =>
    Object.fromEntries(
        await Promise.all(
            Object.entries(servers).map(async ([name, server]) => [name, "url" in server ? { ...server, url: await shield.mcpUrl(server.url) } : server] as const),
        ),
    );

// How one send of a phase ended, and the steering messages its run handed back, known once the phase's channel closes.
interface PhaseOutcome {
    readonly errored: boolean;
    readonly planText: string | undefined;
    readonly handedBack: Promise<readonly string[]>;
}

export const createCursorAgent = (deps: CursorAgentDeps) => {
    // Forwards one phase of the turn's queue; the caller emits `done` once, since a plan turn runs two of these.
    // While planning, the assistant's prose is captured, not streamed, becoming the plan text.
    async function* runPhase(
        agent: CursorSession,
        request: AgentRequest,
        queue: EventQueue<PhaseItem>,
        prompt: string,
        selection: ModelSelection | undefined,
        planning: boolean,
        channel: SteeringChannel | undefined,
        force: boolean,
        shield: TurnShield | undefined,
    ): AsyncGenerator<AgentEvent, PhaseOutcome> {
        const mapper = createCursorEventMapper(request.spec.cwd, planning);
        // Tokens the model writes, read back before the transcript shows them; absent while the shield reads nothing.
        const restorer = shield === undefined ? undefined : createEventRestorer(shield.restore);
        let sawDelta = false;
        const options: SendOptions = {
            mode: modeFor(planning),
            ...(selection !== undefined ? { model: selection } : {}),
            // Only `force` rides the per-send `local`; custom tools not named here fall back to the agent's own.
            ...(force ? { local: { force: true } } : {}),
            // Mapped where it arrives rather than where it is read: the drain below can be parked on a tool handler,
            // and what the mapper captures is read the moment the phase ends.
            onDelta: ({ update }) => {
                sawDelta = true;
                for (const frame of mapper.map(update)) {
                    for (const shown of restorer === undefined ? [frame] : restorer.map(frame)) {
                        queue.push(shown);
                    }
                }
            },
        };

        // Once per phase, however many of the three ways to end one fire; a second sentinel would end the next phase
        // before it had streamed anything.
        let ended = false;
        const endPhase = (): void => {
            if (ended) {
                return;
            }
            ended = true;
            queue.push(PHASE_END);
        };

        let sendError: unknown;
        // Not awaited: frames arrive via onDelta while this resolves; awaiting first would buffer the turn's opening.
        const started: Promise<CursorRunHandle | undefined> = agent.send(prompt, options).catch((error: unknown) => {
            sendError = error;
            endPhase();
            return undefined;
        });

        // Covers both silences the SDK can hold a turn in: a `send` that never resolves, and a run that resolves and
        // then never deltas. Cancel is best-effort, so the phase ends on this timer rather than on the cancel.
        let stalled = false;
        const stall = setTimeout(() => {
            if (sawDelta) {
                return;
            }
            stalled = true;
            void cancelRun(started, deps.logger);
            endPhase();
        }, FIRST_DELTA_MS);
        stall.unref();

        // Stop cancels the run instead of abandoning it, so Cursor unwinds tool calls and the transcript ends resolved.
        const onAbort = (): void => {
            void cancelRun(started, deps.logger);
            setTimeout(endPhase, CANCEL_GRACE_MS).unref();
        };
        // A pre-pull Stop hits an aborted signal no listener catches; unwatched, send starts a run nothing can cancel.
        const unwatchAbort = whenAborted(request.signal, onAbort);

        // Ends the phase when the run itself finishes, ending the drain below.
        let settled = false;

        // Not awaited: it lives as long as this phase's channel, and the frames below are what the turn is waiting on.
        const prepare = (text: string): Promise<string> => (shield === undefined ? Promise.resolve(text) : shield.mask(text, "prompt"));
        const handedBack = channel === undefined ? Promise.resolve([]) : steerInto(started, channel, () => settled, deps.logger, prepare);

        const finished = (async () => {
            const handle = await started;
            if (handle === undefined) {
                return undefined;
            }
            const result = await handle.wait().catch((error: unknown) => {
                sendError = error;
                return undefined;
            });
            settled = true;
            endPhase();
            return result;
        })();

        let errored = false;
        try {
            for await (const item of queue) {
                if (item === PHASE_END) {
                    break;
                }
                if (item.kind === "error") {
                    errored = true;
                }
                yield item;
            }
            // What the restorer still holds goes out before anything that ends the phase.
            for (const frame of restorer?.flush() ?? []) {
                yield frame;
            }
            // Only the run's own settle resolves `finished`; a stall or a cancel grace ends the drain without one, and
            // awaiting it there is the hang this phase is bounded against.
            const result = settled ? await finished : undefined;
            if (stalled) {
                errored = true;
                yield { kind: "error", message: CURSOR_STALLED, code: "provider-outage" };
            } else if (sendError !== undefined) {
                errored = true;
                yield await codedError(sendError, await cursorSdk());
            } else if (result?.status === "error") {
                errored = true;
                yield { kind: "error", message: result.error?.message ?? "The Cursor turn failed." };
            }
            yield* mapper.ending(settled && !errored);
        } finally {
            clearTimeout(stall);
            // One listener per phase; a plan turn runs two, so an unremoved one leaks into the next phase.
            unwatchAbort();
        }
        const captured = mapper.capture();
        const planText = captured.planText === undefined || shield === undefined ? captured.planText : shield.restore(captured.planText);
        return { errored: errored || captured.errored === true, planText, handedBack };
    }

    return async function* cursorAgent(request: AgentRequest<CursorCredential>): AsyncGenerator<AgentEvent> {
        const sdk = await cursorSdk();
        if (sdk === undefined) {
            yield { kind: "error", message: CURSOR_SDK_MISSING };
            yield { kind: "done" };
            return;
        }
        const apiKey = request.credential.apiKey;
        if (apiKey === "") {
            // Reached only when a request is built by hand; planCursorTurn already refuses first with the same code.
            yield { kind: "error", message: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.", code: "subscription-required" };
            yield { kind: "done" };
            return;
        }

        // The SDK requires an explicit model with no default; the catalog is never empty, so this always resolves.
        const modelId = request.spec.model !== undefined && request.spec.model !== "" ? request.spec.model : (await deps.catalog.models()).default;
        const item = await deps.catalog.item(modelId);
        // Without the vendor record (persisted/seeded) the bare id is sent: an untranslatable effort isn't guessed.
        const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, request.spec.effort);

        // Attachments ride the prompt as a file list; Cursor's read tool takes them off disk, like the OpenCode/Pi
        // runtimes. A sealed request's system prompt rides in front of its words: Cursor's SDK has no system seam, and the
        // hook service a turn's instructions go through is a setting source a sealed request does not load.
        const { images, others } = splitAttachments(request.spec.attachments ?? []);
        const system = request.policy.sealed === true ? request.spec.systemPrompt : undefined;
        const words = system === undefined || system === "" ? request.spec.prompt : `${system}\n\n${request.spec.prompt}`;
        const anchor = request.spec.isolation?.anchor;

        // The privacy shield, reading this turn channel by channel (cursor-shield.ts). A sealed request was read whole
        // by the shield before it got here (privacy-shield.ts `seal`), so only a turn carries one.
        const shield = request.policy.sealed === true ? undefined : request.hooks.privacy;
        let shielded: { readonly prompt: string; readonly append: string | undefined; readonly masking: boolean } | undefined;
        if (shield !== undefined) {
            // The hooks are how the shield reads this runtime at all: without them it would read nothing past the prompt.
            const covered = deps.hooks.ready() && (await deps.hooks.covers().catch(() => false));
            const refusal = covered
                ? await shieldedStart(shield, request, anchor, words, [...images, ...others])
                : { refused: { kind: "error" as const, code: "privacy-unshielded" as const, message: CURSOR_HOOKS_MISSING } };
            if ("refused" in refusal) {
                yield refusal.refused;
                yield { kind: "done" };
                return;
            }
            shielded = refusal;
        }
        const basePrompt = shielded?.prompt ?? withFileNote(words, [...images, ...others]);
        const systemAppend = shield === undefined ? request.spec.systemAppend : shielded?.append;

        // One stream for the turn, two producers: the SDK's mapped deltas, and the custom tool handlers and hooks that
        // run inside Cursor's loop with no generator to yield from. They share it because a handler that parks on a
        // person is itself what stops the deltas, so a card waiting for the next one would never be shown — and the
        // handler holding the turn would never be answered.
        const queue = new EventQueue<PhaseItem>();
        const push = (event: AgentEvent): void => queue.push(event);

        // Rulebook axis "hooks" makes a hold park on a card, not refuse, while the hook process waits on the socket.
        // Built ahead of the options because the JS backend rides a custom tool and consults this gate from inside its
        // own handler, where no hook can reach it.
        const { gate, taint, release } = vendorTurnGate(request);

        // While the shield reads the turn the daemon's own tools mask what they answer and every MCP server is reached
        // through the masking proxy; while it masks, the tools that read past it are withheld too. Watching changes
        // nothing Cursor can do: it only reads what passes.
        const customTools = cursorCustomTools(request, { gate, taint }, push);
        const mcpServers = cursorMcpServers(request);
        const options: AgentOptions =
            request.policy.sealed === true
                ? sealedOptions(selection, apiKey, request.spec.cwd)
                : {
                      model: selection,
                      apiKey,
                      disallowedTools: shielded?.masking === true ? [...TOOLS_WITHHELD, ...SHIELD_WITHHELD] : [...TOOLS_WITHHELD],
                      local: {
                          cwd: request.spec.cwd,
                          // mdm carries the command gate (cursor-hooks.ts); user is skipped, it also reads this daemon's
                          // Claude settings.
                          settingSources: ["mdm", "project"],
                          customTools: shield === undefined ? customTools : shieldedCustomTools(customTools, shield),
                      },
                      mcpServers: shield === undefined ? mcpServers : await proxiedMcpServers(mcpServers, shield),
                  };

        // An anchored turn's agent runs in a runtime process born in its namespace, so the shell the SDK spawns and the
        // files it edits resolve /work to the worktree, as every other isolated runtime's do. The anchor's cwd is already
        // this request's cwd (stream-agent.ts), so the local store scopes the session the same way in either process.
        const host =
            anchor === undefined
                ? inProcessHost(sdk)
                : namespacedHost({
                      namespace: { pid: anchor.pid, cwd: anchor.cwd, ...opt("namespace", anchor.namespace) },
                      sdk,
                      sdkEntry: await cursorSdkEntry(),
                      spawnDepth: request.spec.spawnDepth ?? 0,
                      logger: deps.logger,
                      ...opt("owner", request.spec.conversationId),
                      ...deps.runtime,
                  });

        let agent: CursorSession | undefined;
        try {
            agent = await host(request.spec.sessionId, options);
        } catch (error) {
            release();
            yield await codedError(error, sdk);
            yield { kind: "done" };
            return;
        }

        // Session id a follow-up resumes on, and the id the hook gate correlates a consult back to.
        yield { kind: "session", sessionId: agent.agentId };
        yield { kind: "init", model: modelId };

        // The session's shell gets the turn's credentials and the heavy table's environment, so its programs queue
        // and its installs take the install lane as a Claude Code turn's do.
        const shellEnv = { ...request.tools.cliEnv, ...(await vendorShellEnv(request.tools, { ...process.env, ...request.tools.cliEnv })) };
        const retire = deps.hooks.register({
            conversationId: agent.agentId,
            ...(Object.keys(shellEnv).length > 0 ? { cliEnv: shellEnv } : {}),
            ...(systemAppend !== undefined ? { systemAppend } : {}),
            gate,
            push,
            ...(shield !== undefined ? { shield: cursorHookShield(shield) } : {}),
        });

        // This turn's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const relay = request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering);

        // The SDK's local store marks a run finished only from inside the process that ran it, so a daemon killed
        // mid-run (an OOM kill, a restart) leaves that run RUNNING on disk, and every later send on the agent throws
        // "already has active run" for good. Turns on one conversation are serialized, so any run still open when a
        // resumed agent's first send goes out is that orphan: `force` expires it, the SDK's own recovery for exactly
        // this. Later phases of the same turn follow a run this process settled itself, and are sent plainly.
        let orphanPossible = request.spec.sessionId !== undefined;

        try {
            const live = agent;
            const send = async function* (prompt: string, planning: boolean): AsyncGenerator<AgentEvent, { errored: boolean; planText?: string }> {
                // Each phase borrows its own channel and closes it, so a message typed during a plan's approval pause
                // waits for the executing phase instead of being delivered to the run that already finished.
                const channel = relay?.();
                const force = orphanPossible;
                orphanPossible = false;
                try {
                    const outcome = yield* runPhase(live, request, queue, prompt, selection, planning, channel, force, shield);
                    // The run has settled, so this phase takes no more steering. Planning leaves what is still queued
                    // for the executing phase; the last phase closes the turn's queue, so a message sent after this is
                    // refused at the route rather than left in a relay nothing will read again.
                    if (planning) {
                        channel?.close();
                    } else {
                        request.spec.steering?.close();
                    }
                    const handedBack = await outcome.handedBack;
                    if (handedBack.length === 0 || outcome.errored || request.signal.aborted) {
                        if (handedBack.length > 0) {
                            deps.logger.warn(
                                { messages: handedBack.length },
                                "cursor: steering messages not taken by a run that failed or was stopped",
                            );
                        }
                        return { errored: outcome.errored, ...opt("planText", outcome.planText) };
                    }
                    // Sent on the same agent and in the same mode, so a plan still ends in a plan; it has no steering of
                    // its own, since admission already closed. Masked again while the shield reads the turn.
                    const typed = handedBack.join("\n\n");
                    const followUpPrompt = shield === undefined ? typed : await shield.mask(typed, "prompt").catch(() => undefined);
                    if (followUpPrompt === undefined) {
                        yield { kind: "error", message: "The privacy shield could not mask the messages sent during this turn, so they were not sent." };
                        return { errored: true, ...opt("planText", outcome.planText) };
                    }
                    const followUp = yield* runPhase(live, request, queue, followUpPrompt, selection, planning, undefined, false, shield);
                    return { errored: followUp.errored, ...opt("planText", followUp.planText ?? outcome.planText) };
                } finally {
                    channel?.close();
                }
            };

            yield* planMode(
                CURSOR,
                request,
                () => ({
                    // The preamble rides the prompt though mode:"plan" enforces read-only: it tells the model to end with a
                    // plan.
                    prompt: `${PLAN_PREAMBLE}${basePrompt}`,
                    async *plan(prompt) {
                        const outcome = yield* send(prompt, true);
                        // Session never changes across phases; reporting undefined here keeps the emulation's seed rather
                        // than reassigning it.
                        return { sessionId: undefined, planText: outcome.planText, errored: outcome.errored };
                    },
                    execute: () => send(EXECUTE_PROMPT, false),
                }),
                () => send(basePrompt, false),
            );
        } finally {
            // Order matters: retire, then release, then close; a consult between finds no turn, and is allowed. The
            // release also settles a card a hook or tool left open when the run ended without waiting for it.
            retire();
            release();
            agent.close();
        }
        yield { kind: "done" };
    };
};
