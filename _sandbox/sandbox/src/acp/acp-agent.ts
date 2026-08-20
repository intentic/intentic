import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { type ContentBlock, type McpServer, methods, type PromptResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpAgentConfig, AgentEvent } from "@intentic/sandbox-contract";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import type { AgentRequest } from "../agent/agent.js";
import { splitAttachments, withFileNote } from "../agent/attachment-note.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";
import { sessionUpdateEvent } from "./acp-events.js";
import { decidePermission, type PermissionPhase } from "./acp-permissions.js";

/* The ACP provider adapter: the same seam as runAgent/createCodexAgent/createGrokAgent. AgentRequest in,
 * AgentEvent frames out, over ANY agent speaking the Agent Client Protocol, resolved from an `agent`-kind
 * capability. One warm connection per agent (see acp-connection.ts); one ACP session per conversation;
 * session/update notifications map through acp-events onto the shared vocabulary.
 *
 * ACP-run agents get a documented floor rather than the native ceiling, and "documented" now means a row in
 * the contract's agent-catalog.ts (`capabilitiesOf(…).runtime === "acp"`) that the composer reads out loud: the
 * agent owns its own model and reasoning settings, our http MCP tools pass through only when it advertises
 * them, there are no rate-limit or usage-limit frames, and plan mode is the shared two-phase emulation with a
 * permission-level read-only guard. Terminals ARE surfaced, an agent's terminal/create runs in the
 * conversation's tmux session, which the panel attaches to exactly as it does for a Claude Bash call. */

// Generalized from the Grok watchdogs: no update for our session ⇒ cancel + kill; one turn never runs
// forever. Injectable for tests (the Grok inactivityMs precedent).
export interface AcpTimeouts {
    readonly inactivityMs: number;
    readonly maxTurnMs: number;
}
const DEFAULT_TIMEOUTS: AcpTimeouts = { inactivityMs: 120_000, maxTurnMs: 30 * 60_000 };

const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

// Native image blocks when the agent advertises image prompts; unreadable files degrade to a path note.
const imageBlocks = async (paths: readonly string[]): Promise<{ blocks: ContentBlock[]; unread: string[] }> => {
    const blocks: ContentBlock[] = [];
    const unread: string[] = [];
    for (const path of paths) {
        try {
            const data = await readFile(path);
            blocks.push({ type: "image", data: data.toString("base64"), mimeType: IMAGE_MIME[extname(path).toLowerCase()] ?? "image/png" });
        } catch {
            unread.push(path);
        }
    }
    return { blocks, unread };
};

// The agent's MCP servers: the daemon's http tools pass through when the agent advertises http MCP support;
// in-process SDK servers have no ACP projection (accepted loss for ACP turns).
const mcpServersOf = (request: AgentRequest, connection: AcpConnection): McpServer[] => {
    if (connection.capabilities.mcpCapabilities?.http !== true) {
        return [];
    }
    return (request.tools ?? []).map((tool) => ({
        type: "http",
        name: tool.name,
        url: tool.url,
        headers: tool.token !== undefined ? [{ name: "Authorization", value: `Bearer ${tool.token}` }] : [],
    }));
};

const errorText = (error: unknown, stderrTail: string): string => {
    // The SDK wraps a throwing agent handler as RequestError("Internal error") with the real reason in
    // data.details, unwrap it so the surfaced line says what actually happened.
    const details = (error as { data?: { details?: unknown } }).data?.details;
    const base = typeof details === "string" && details !== "" ? details : error instanceof Error ? error.message : "ACP agent failed";
    const detail = stderrTail.trim();
    return detail === "" ? base : `${base}: ${detail}`;
};

interface TurnOutcome {
    readonly sessionId: string | undefined;
    // Agent text held back during a plan phase (becomes the plan frame).
    readonly text: string;
    readonly errored: boolean;
}

// The turn loop's idle wake latch, swapped for the wait race's resolver while a wait is in flight.
const noopWake = (): void => {};

// One prompt turn on one session: resolve/create/load the session, bind the turn's routing, prompt, and
// stream mapped updates until the PromptResponse settles (or a watchdog fires). Does NOT emit the terminal
// `done`, callers do once the whole turn (incl. plan phases) settles.
async function* runAcpTurn(
    connection: AcpConnection,
    request: AgentRequest,
    prompt: ContentBlock[],
    sessionId: string | undefined,
    phase: PermissionPhase,
    captureText: boolean,
    timeouts: AcpTimeouts,
): AsyncGenerator<AgentEvent, TurnOutcome> {
    let sid = sessionId;
    if (sid !== undefined && !connection.sessions.has(sid)) {
        // A fresh process doesn't know this session. session/load replays the conversation via session/update
        // BEFORE responding, no turn is bound yet, so the replay is dropped (we resume, not re-render).
        if (connection.capabilities.loadSession === true) {
            try {
                await connection.agent.request(methods.agent.session.load, {
                    sessionId: sid,
                    cwd: request.cwd,
                    mcpServers: mcpServersOf(request, connection),
                });
                connection.sessions.add(sid);
            } catch {
                yield {
                    kind: "error",
                    code: "session-not-found",
                    message: "The agent no longer has this chat's session. Send again to start fresh.",
                };
                return { sessionId: undefined, text: "", errored: true };
            }
        } else {
            yield {
                kind: "error",
                code: "session-not-found",
                message: "The agent restarted and cannot resume this chat's session. Send again to start fresh.",
            };
            return { sessionId: undefined, text: "", errored: true };
        }
    }
    if (sid === undefined) {
        const created = await connection.agent.request(methods.agent.session.new, {
            cwd: request.cwd,
            mcpServers: mcpServersOf(request, connection),
        });
        sid = created.sessionId;
        connection.sessions.add(sid);
        yield { kind: "session", sessionId: sid };
    }

    const queue: AgentEvent[] = [];
    let text = "";
    let wake: () => void = noopWake;
    const onUpdate = (notification: SessionNotification): void => {
        const update = notification.update;
        if (captureText && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            // Plan phase: the agent's answer IS the plan, held back, not streamed as deltas.
            text += update.content.text;
            wake();
            return;
        }
        const event = sessionUpdateEvent(update, request.cwd);
        if (event !== undefined) {
            queue.push(event);
        }
        wake();
    };
    // Terminal context: the agent's terminal/create commands run in the conversation's agent-<id> tmux
    // session; the first create surfaces it in the panel, the exact Claude-Bash UX.
    const tmuxSession = agentSessionName(sid);
    let terminalSurfaced = false;
    const unbind = connection.bindTurn(sid, {
        onUpdate,
        permission: (permissionRequest) => decidePermission(permissionRequest, phase, request.signal.aborted),
        ...(tmuxSession !== undefined
            ? {
                  terminal: {
                      session: tmuxSession,
                      cwd: request.cwd,
                      onCreate: () => {
                          if (!terminalSurfaced) {
                              terminalSurfaced = true;
                              queue.push({ kind: "terminal", session: tmuxSession });
                              wake();
                          }
                      },
                  },
              }
            : {}),
    });

    const session = sid;
    const cancel = (): void => void connection.agent.notify(methods.agent.session.cancel, { sessionId: session }).catch(() => {});
    request.signal.addEventListener("abort", cancel, { once: true });

    let settled = false;
    let response: PromptResponse | undefined;
    let failure: unknown;
    const promptPromise = connection.agent
        .request(methods.agent.session.prompt, { sessionId: session, prompt })
        .then((result) => {
            response = result;
        })
        .catch((error: unknown) => {
            failure = error;
        })
        .finally(() => {
            settled = true;
            wake();
        });

    const turnDeadline = Date.now() + timeouts.maxTurnMs;
    let inactivityDeadline = Date.now() + timeouts.inactivityMs;
    try {
        for (;;) {
            if (queue.length > 0) {
                inactivityDeadline = Date.now() + timeouts.inactivityMs;
                yield queue.shift() as AgentEvent;
                continue;
            }
            if (settled) {
                break;
            }
            const waitMs = Math.min(inactivityDeadline, turnDeadline) - Date.now();
            if (waitMs <= 0) {
                // Watchdog: the agent went silent (or ran forever). Cancel is best-effort; the kill is not,
                // sessions die with the process and the session-not-found self-heal covers the next send.
                cancel();
                connection.kill();
                yield { kind: "error", message: "ACP agent timed out — no activity from the agent. It was stopped; send again to retry." };
                return { sessionId: session, text, errored: true };
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                new Promise<void>((resolve) => {
                    wake = resolve;
                }),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, waitMs);
                }),
            ]);
            clearTimeout(timer);
            wake = noopWake;
        }
        await promptPromise;
        if (failure !== undefined) {
            yield { kind: "error", message: errorText(failure, connection.stderrTail()) };
            return { sessionId: session, text, errored: true };
        }
        const stopReason = response?.stopReason;
        if (stopReason === "refusal") {
            yield { kind: "error", message: "The agent refused this request." };
            return { sessionId: session, text, errored: true };
        }
        if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
            yield { kind: "error", message: `The agent stopped early (${stopReason}).` };
            return { sessionId: session, text, errored: true };
        }
        // end_turn | cancelled, the turn settled normally (cancelled surfaces nothing extra; the user stopped it).
        return { sessionId: session, text, errored: false };
    } finally {
        unbind();
        request.signal.removeEventListener("abort", cancel);
    }
}

// Build the ACP provider for the Services seam. `id`/`config` come from the turn's resolved `agent`-kind
// capability (streamAgent's dispatch); a connection failure surfaces as an error frame, then done.
export const createAcpAgent = (connections: AcpConnections, timeouts: AcpTimeouts = DEFAULT_TIMEOUTS) =>
    async function* runAcpAgent(id: string, config: AcpAgentConfig, request: AgentRequest): AsyncGenerator<AgentEvent> {
        let connection: AcpConnection;
        try {
            connection = await connections.acquire(id, config, request.cwd);
        } catch (error) {
            yield { kind: "error", message: error instanceof Error ? error.message : "ACP agent failed to start" };
            yield { kind: "done" };
            return;
        }

        const { images, others } = splitAttachments(request.attachments);
        const nativeImages = connection.capabilities.promptCapabilities?.image === true;
        const { blocks, unread } = nativeImages ? await imageBlocks(images) : { blocks: [], unread: [...images] };
        const prompt = withFileNote(request.prompt, [...others, ...unread]);

        try {
            if (request.permissionMode === "plan") {
                // Plan flow is text-only prompts; attachment paths ride the note (images too, the planning
                // phase reads, it doesn't look at screenshots natively; keeping phases uniform beats cleverness).
                const planPhase: PlanPhase = async function* (phasePrompt, sessionId) {
                    const outcome = yield* runAcpTurn(connection, request, [{ type: "text", text: phasePrompt }], sessionId, "plan", true, timeouts);
                    return { sessionId: outcome.sessionId, planText: outcome.text, errored: outcome.errored };
                };
                const executePhase: ExecutePhase = async function* (sessionId) {
                    yield* runAcpTurn(connection, request, [{ type: "text", text: EXECUTE_PROMPT }], sessionId, "execute", false, timeouts);
                };
                yield* runPlanEmulation(
                    request.signal,
                    PLAN_PREAMBLE + withFileNote(request.prompt, [...others, ...images]),
                    request.sessionId,
                    planPhase,
                    executePhase,
                );
            } else {
                yield* runAcpTurn(connection, request, [{ type: "text", text: prompt }, ...blocks], request.sessionId, "execute", false, timeouts);
            }
        } catch (error) {
            // A throwing turn (session/new failure, connection torn down mid-turn) surfaces, never swallows.
            yield { kind: "error", message: errorText(error, connection.stderrTail()) };
        }
        yield { kind: "done" };
    };
