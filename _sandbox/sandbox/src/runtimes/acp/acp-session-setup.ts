import { type McpServer, methods, RequestError } from "@agentclientprotocol/sdk/unstable";
import { TimeoutError } from "@intentic/base/async";
import { offeredChoice, recordOptions, thoughtFor } from "@intentic/acp-events/model";
import { isBypassMode, modeFor, noteMode, recordModes } from "@intentic/acp-events/modes";
import { sessionMissing } from "@intentic/acp-events/session-missing";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { withStderrTail } from "../../engines/failure-sentences.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import type { AcpConnection } from "./acp-connection.js";
import { acpMcpProxyFile, stdioProxyServer } from "./acp-mcp-proxy.js";
import type { PermissionPhase } from "./acp-permissions.js";
import { type AcpTimeouts, type SetupStep, setupStep } from "./acp-prompt.js";
import type { AcpSessionMeta } from "./acp-spawn.js";

// Setting a phase's session up before its prompt (acp-agent.ts runAcpTurn): opening or reopening it, then putting it on
// the turn's model, reasoning depth and mode. Every request here is held to its own deadline and the turn's stop
// (acp-prompt.ts setupStep), since the turn's watchdog starts only once the prompt is sent.

// A model the session's own option does not offer: the account's list moved since the catalog last read it.
class ModelNotOffered extends Error {}

// A session the agent would not take out of its run-without-asking mode, on a turn that asked for a person's approvals
// or whose rulebook is watching: running on would let every call past both.
class ModeNotLeft extends Error {}

// The agent's MCP servers: the turn's remote list (every mount at the daemon's MCP door: browsers, the mcp-kind cards and
// the daemon's own servers) over http where the agent advertises http MCP, else as stdio servers through the daemon's
// proxy (acp-mcp-proxy.ts), stdio being the transport every ACP agent must take. In-process SDK servers have no ACP
// projection; the daemon's own reach the agent through the door instead (daemon-servers.ts).
const mcpServersOf = async (request: AgentRequest, connection: AcpConnection): Promise<McpServer[]> => {
    const tools = request.tools.remote ?? [];
    if (tools.length === 0) {
        return [];
    }
    if (connection.capabilities.mcpCapabilities?.http === true) {
        return tools.map((tool) => ({
            type: "http",
            name: tool.name,
            url: tool.url,
            headers: tool.token === undefined ? [] : [{ name: "Authorization", value: `Bearer ${tool.token}` }],
        }));
    }
    const script = await acpMcpProxyFile();
    return tools.map((tool) => stdioProxyServer(tool, script));
};

// The SDK wraps a throwing handler as "Internal error"; the real reason lives in data.details, unwrapped here.
export const failureOf = (error: unknown): string => {
    const details = (error as { data?: { details?: unknown } }).data?.details;
    return typeof details === "string" && details !== "" ? details : error instanceof Error ? error.message : "ACP agent failed";
};

export type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// A failure as its frame: the protocol's own auth_required (ACP credentials belong to the capability, not a native provider
// account's reconnect flow); the agent's sentence is read where every runtime's is (codedFailure).
export const failureFrame = (message: string, error: unknown): ErrorFrame =>
    error instanceof RequestError && error.code === RequestError.authRequired().code ? { kind: "error", message, code: "acp-auth-required" } : { kind: "error", message };

// The session a phase runs on: the one asked for when this process holds it or can load it, else a new one, announced. A
// session the agent can't bring back is the coded self-heal every runtime shares: the next send starts fresh.
async function* sessionFor(
    connection: AcpConnection,
    request: AgentRequest,
    sessionId: string | undefined,
    meta: AcpSessionMeta | undefined,
    step: SetupStep,
): AsyncGenerator<AgentEvent, string | undefined> {
    if (sessionId !== undefined && connection.sessions.has(sessionId)) {
        return sessionId;
    }
    if (sessionId !== undefined) {
        // A fresh process doesn't know this session; session/load's replay arrives unbound, so it's dropped.
        if (connection.capabilities.loadSession !== true) {
            yield {
                kind: "error",
                code: "session-not-found",
                message: "The agent restarted and cannot resume this chat's session. Send again to start fresh.",
            };
            return undefined;
        }
        // Only an explicit missing resource retires the session; authentication and replay failures may recover.
        const refused = await step("open", "while reopening this chat's session (session/load)", async () =>
            connection.agent.request(methods.agent.session.load, {
                sessionId,
                cwd: request.spec.cwd,
                mcpServers: await mcpServersOf(request, connection),
                ...opt("_meta", meta === undefined ? undefined : { ...meta }),
            }),
        ).then(
                (loaded) => {
                    recordOptions(connection, sessionId, loaded.configOptions);
                    recordModes(connection.modes, sessionId, loaded.modes);
                    return false;
                },
                (error: unknown) => {
                    if (error instanceof RequestError && sessionMissing(error)) {
                        return true;
                    }
                    throw error;
                },
            );
        if (refused) {
            yield { kind: "error", code: "session-not-found", message: "The agent no longer has this chat's session. Send again to start fresh." };
            return undefined;
        }
        connection.sessions.add(sessionId);
        return sessionId;
    }
    const created = await step("open", "while starting a session (session/new)", async () =>
        connection.agent.request(methods.agent.session.new, {
            cwd: request.spec.cwd,
            mcpServers: await mcpServersOf(request, connection),
            ...opt("_meta", meta === undefined ? undefined : { ...meta }),
        }),
    );
    recordOptions(connection, created.sessionId, created.configOptions);
    recordModes(connection.modes, created.sessionId, created.modes);
    connection.sessions.add(created.sessionId);
    yield { kind: "session", sessionId: created.sessionId };
    return created.sessionId;
}

// Puts the session on the model asked for and answers what it now runs on. Undefined when the agent offers no model
// option for this session: it keeps its own. Asking for one it does not offer throws ModelNotOffered rather than
// running the turn on a model nobody picked.
const settleModel = async (connection: AcpConnection, sessionId: string, asked: string, step: SetupStep): Promise<string | undefined> => {
    const models = connection.models.get(sessionId);
    if (models === undefined) {
        return undefined;
    }
    const wanted = offeredChoice(models, asked);
    if (wanted === undefined) {
        const offered = models.choices.map((choice) => choice.name).join(", ");
        throw new ModelNotOffered(
            `${asked} is not one of the models this account offers${offered === "" ? "" : ` (${offered})`}. Pick another model.`,
        );
    }
    if (models.current === wanted) {
        return models.current;
    }
    const answer = await step("option", `while switching the session to ${wanted} (session/set_config_option)`, () =>
        connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: models.configId, value: wanted }),
    );
    return recordOptions(connection, sessionId, answer.configOptions)?.current ?? wanted;
};

// Puts the session on the reasoning depth nearest the turn's effort, where the agent offers a `thought_level` option.
// Advisory, like every runtime's effort: a level the agent refuses leaves its own, and the turn runs on.
const settleThought = async (connection: AcpConnection, sessionId: string, effort: string | undefined, step: SetupStep): Promise<void> => {
    const thoughts = connection.thoughts.get(sessionId);
    const wanted = effort === undefined || thoughts === undefined ? undefined : thoughtFor(thoughts, effort);
    if (thoughts === undefined || wanted === undefined || wanted === thoughts.current) {
        return;
    }
    const answer = await step("option", "while setting the reasoning depth (session/set_config_option)", () =>
        connection.agent
            .request(methods.agent.session.setConfigOption, { sessionId, configId: thoughts.configId, value: wanted })
            // allow(silent-catch): reasoning depth is advisory; the session keeps the agent's own level
            .catch(() => undefined),
    );
    if (answer !== undefined) {
        recordOptions(connection, sessionId, answer.configOptions);
    }
};

// Puts the session in the mode this phase's posture maps onto (acp-events modes.ts `modeFor`); an agent advertising no modes
// is left as it is. A refused switch is tolerated, except out of a bypass mode, which ModeNotLeft refuses the turn over.
const settleMode = async (
    connection: AcpConnection,
    sessionId: string,
    phase: PermissionPhase,
    permissionMode: PermissionMode | undefined,
    rulebookEnforcing: boolean,
    step: SetupStep,
): Promise<void> => {
    const modes = connection.modes.get(sessionId);
    const target = modes === undefined ? undefined : modeFor(modes, phase, permissionMode, rulebookEnforcing);
    if (modes === undefined || target === undefined || target === modes.current) {
        return;
    }
    const switched = await step("option", `while switching to its ${target} mode (session/set_mode)`, () =>
        connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: target }).then(
            () => true,
            () => false,
        ),
    );
    if (switched) {
        noteMode(connection.modes, sessionId, target);
        return;
    }
    if (isBypassMode(modes, modes.current)) {
        throw new ModeNotLeft(`The agent would not leave its ${modes.current} mode, which runs every call without asking. Send again to retry.`);
    }
};

// What a phase's setup needs of its turn.
export interface SetupTurn {
    readonly timeouts: AcpTimeouts;
    readonly model: { readonly wanted: string | undefined };
    readonly sessionMeta: AcpSessionMeta | undefined;
    readonly phase: PermissionPhase;
    readonly gate: Pick<CommandGuard, "enforcing">;
}

// The phase's session once set up, what model it announced it runs on, and whether setup failed (its frame already said).
export interface PhaseSession {
    readonly session: string | undefined;
    readonly running: string | undefined;
    readonly failed: boolean;
}

// Why setup failed, as the frame the turn ends on; nothing on a stop, which the person asked for.
const setupFailure = (error: unknown, connection: AcpConnection, signal: AbortSignal): ErrorFrame | undefined => {
    if (signal.aborted) {
        return undefined;
    }
    if (error instanceof ModelNotOffered) {
        return { kind: "error", code: "model-unavailable", message: error.message };
    }
    if (error instanceof ModeNotLeft) {
        return { kind: "error", message: error.message };
    }
    return failureFrame(withStderrTail(failureOf(error), connection.stderrTail()), error);
};

/** Opens the phase's session and settles its options; a failure is said here and comes back as `failed`. */
export async function* openPhaseSession(
    connection: AcpConnection,
    request: AgentRequest,
    sessionId: string | undefined,
    turn: SetupTurn,
): AsyncGenerator<AgentEvent, PhaseSession> {
    let session: string | undefined;
    let running: string | undefined;
    const step = setupStep(turn.timeouts, request.signal);
    try {
        session = yield* sessionFor(connection, request, sessionId, turn.sessionMeta, step);
        if (session !== undefined) {
            running = turn.model.wanted !== undefined ? await settleModel(connection, session, turn.model.wanted, step) : undefined;
            await settleThought(connection, session, request.spec.effort, step);
            await settleMode(connection, session, turn.phase, request.policy.permissionMode, turn.gate.enforcing, step);
        }
    } catch (error) {
        if (error instanceof TimeoutError && session !== undefined && !request.signal.aborted) {
            // A session the agent stopped answering on is given up, as the watchdog gives up a stalled prompt's: the
            // process ends when no other turn is on it, and the next send self-heals.
            connection.abandon(session);
        }
        const frame = setupFailure(error, connection, request.signal);
        if (frame !== undefined) {
            yield frame;
        }
        return { session, running, failed: true };
    }
    return { session, running, failed: false };
}
