import { randomBytes } from "node:crypto";
import { agent, type AgentApp, type AgentContext, methods, RequestError, type RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { type BridgeConfig, readSessions, resolveConfig, writeSessions } from "./config.js";
import { createDaemonClient, type DaemonClient } from "./daemon-client.js";
import { sessionUpdateOf } from "./translate.js";

/* The ACP agent the editor spawns: a thin stdio bridge onto the intentic sandbox daemon. One ACP session =
 * one daemon conversation (bridge-minted id); each session/prompt streams POST /agent and translates
 * AgentEvents into session/update notifications. Control flow the daemon models as side channels maps onto
 * ACP's one interactive primitive, request_permission: a plan frame becomes a "Review plan" tool call with
 * Approve/Keep-planning options (the claude-code-acp ExitPlanMode pattern), an AskUserQuestion frame becomes
 * one permission request per question (multiSelect collapses to a single choice — documented loss). Modes:
 * [code, plan] map to the daemon's per-turn permissionMode, which is exactly what the web sends too. */

// The daemon constrains conversation ids (branch/filesystem safety); this always satisfies its regex.
const mintSessionId = (): string => `acp-${randomBytes(9).toString("base64url").replaceAll(/[^a-zA-Z0-9_-]/g, "")}`;

interface SessionState {
    readonly conversationId: string;
    cwd: string;
    mode: "code" | "plan";
    providerSessionId: string | undefined;
    abort: AbortController | undefined;
    cancelled: boolean;
}

const MODES = {
    currentModeId: "code",
    availableModes: [
        { id: "code", name: "Code", description: "Execute directly with full tool access" },
        { id: "plan", name: "Plan", description: "Propose a plan and wait for approval before executing" },
    ],
};

export interface BridgeOptions {
    // Injectable for tests: the resolved config (env/file otherwise) and the daemon-client factory.
    readonly config?: BridgeConfig;
    readonly clientFor?: (url: string, token: string) => DaemonClient;
    readonly configDir?: string;
    readonly version?: string;
}

// A plan frame → a "Review plan" tool call + permission prompt; the outcome rides the decision channel.
const reviewPlan = async (ctx: AgentContext, sessionId: string, daemon: DaemonClient, event: Extract<AgentEvent, { kind: "plan" }>): Promise<void> => {
    const toolCallId = `plan-${event.requestId}`;
    await ctx.notify(methods.client.session.update, {
        sessionId,
        update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Review plan",
            kind: "other",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: event.text } }],
        },
    });
    const response = await ctx.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId, title: "Review plan" },
        options: [
            { optionId: "approve", name: "Approve plan", kind: "allow_once" },
            { optionId: "reject", name: "Keep planning", kind: "reject_once" },
        ],
    });
    const approved = response.outcome.outcome === "selected" && response.outcome.optionId === "approve";
    // Rejection feedback is canned — permission prompts carry no free text (documented loss; the daemon
    // loops another planning turn on the same stream).
    // No mode: this single-option card can't ask which posture to execute in, so the daemon restores the one
    // the turn started with (auto-accept edits when it started in plan mode).
    await daemon.postReply({
        kind: "plan",
        requestId: event.requestId,
        approve: approved,
        ...(approved ? {} : { feedback: "Revise the plan." }),
    });
    await ctx.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: approved ? "completed" : "failed" },
    });
};

// AskUserQuestion → one permission request per question; multiSelect collapses to a single choice.
const askQuestions = async (
    ctx: AgentContext,
    sessionId: string,
    daemon: DaemonClient,
    event: Extract<AgentEvent, { kind: "question" }>,
): Promise<void> => {
    const answers: Record<string, string[]> = {};
    for (const [index, question] of event.questions.entries()) {
        const toolCallId = `question-${event.requestId}-${index}`;
        await ctx.notify(methods.client.session.update, {
            sessionId,
            update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: question.header,
                kind: "other",
                status: "in_progress",
                content: [{ type: "content", content: { type: "text", text: question.question } }],
            },
        });
        const permissionRequest: RequestPermissionRequest = {
            sessionId,
            toolCall: { toolCallId, title: question.question },
            options: [
                ...question.options.map((option) => ({ optionId: option.label, name: option.label, kind: "allow_once" as const })),
                { optionId: "__dismiss", name: "Dismiss", kind: "reject_once" as const },
            ],
        };
        const response = await ctx.request(methods.client.session.requestPermission, permissionRequest);
        const picked = response.outcome.outcome === "selected" && response.outcome.optionId !== "__dismiss" ? response.outcome.optionId : undefined;
        await ctx.notify(methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId, status: picked !== undefined ? "completed" : "failed" },
        });
        if (picked === undefined) {
            await daemon.postReply({ kind: "question", requestId: event.requestId, cancelled: true });
            return;
        }
        answers[question.question] = [picked];
    }
    await daemon.postReply({ kind: "question", requestId: event.requestId, answers });
};

export const bridgeAgentApp = (options: BridgeOptions = {}): AgentApp => {
    const sessions = new Map<string, SessionState>();
    const configured = (): BridgeConfig | undefined => options.config ?? resolveConfig();
    const daemonFor = (config: BridgeConfig): DaemonClient => (options.clientFor ?? createDaemonClient)(config.url, config.token);

    const persistSessions = (): void => {
        const map = readSessions(options.configDir);
        for (const [id, state] of sessions) {
            map[id] = {
                conversationId: state.conversationId,
                agent: configured()?.agent ?? "claude",
                ...(state.providerSessionId !== undefined ? { providerSessionId: state.providerSessionId } : {}),
            };
        }
        writeSessions(map, options.configDir);
    };

    const requireConfig = (): BridgeConfig => {
        const config = configured();
        if (config === undefined) {
            throw RequestError.authRequired({
                details: "Set INTENTIC_SANDBOX_URL and INTENTIC_BRIDGE_TOKEN (mint a token in the sandbox's Sync settings), or run `intentic-acp login`.",
            });
        }
        return config;
    };

    return agent({ name: "intentic" })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentInfo: { name: "intentic", version: options.version ?? "0.0.0" },
            agentCapabilities: {
                // Only Claude transcripts are readable from the daemon's session store today — an honest,
                // provider-conditional capability, not a lie.
                loadSession: (configured()?.agent ?? "claude") === "claude",
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            authMethods: [
                {
                    type: "env_var",
                    id: "env",
                    name: "Bridge token",
                    description: "Mint a bridge token in the sandbox's Sync settings and provide it via environment variables.",
                    vars: [
                        { name: "INTENTIC_SANDBOX_URL", label: "Sandbox URL", secret: false },
                        { name: "INTENTIC_BRIDGE_TOKEN", label: "Bridge token", secret: true },
                        { name: "INTENTIC_AGENT", label: "Agent (claude | codex | grok | ACP capability id)", secret: false, optional: true },
                    ],
                    link: "https://intentic.dev/docs/editor-bridge",
                },
                { type: "terminal", id: "login", name: "Interactive login", description: "Paste the sandbox URL and a bridge token.", args: ["login"] },
            ],
        }))
        .onRequest(methods.agent.authenticate, async () => {
            const config = requireConfig();
            await daemonFor(config).listSessions();
            return {};
        })
        .onRequest(methods.agent.session.new, ({ params }) => {
            requireConfig();
            const sessionId = mintSessionId();
            sessions.set(sessionId, {
                conversationId: sessionId,
                cwd: params.cwd,
                mode: "code",
                providerSessionId: undefined,
                abort: undefined,
                cancelled: false,
            });
            persistSessions();
            return { sessionId, modes: MODES };
        })
        .onRequest(methods.agent.session.load, async ({ params, client: ctx }) => {
            const config = requireConfig();
            const stored = readSessions(options.configDir)[params.sessionId];
            if (stored === undefined) {
                throw RequestError.invalidParams({ details: `unknown session ${params.sessionId}` });
            }
            sessions.set(params.sessionId, {
                conversationId: stored.conversationId,
                cwd: params.cwd,
                mode: "code",
                // Resume only on the same provider — a switched INTENTIC_AGENT starts fresh (the daemon would
                // reject a foreign runtime's session id anyway; this fails cleanly earlier).
                providerSessionId: stored.agent === config.agent ? stored.providerSessionId : undefined,
                abort: undefined,
                cancelled: false,
            });
            // Replay the transcript (role/text only — tool calls are not persisted in the readable store) as
            // message chunks BEFORE returning, per the spec.
            if (stored.providerSessionId !== undefined && stored.agent === "claude") {
                const messages = await daemonFor(config)
                    .getSession(stored.providerSessionId)
                    .catch(() => []);
                for (const message of messages) {
                    await ctx.notify(methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                            content: { type: "text", text: message.text },
                        },
                    });
                }
            }
            return { modes: MODES };
        })
        .onRequest(methods.agent.session.setMode, ({ params }) => {
            const state = sessions.get(params.sessionId);
            if (state === undefined) {
                throw RequestError.invalidParams({ details: `unknown session ${params.sessionId}` });
            }
            state.mode = params.modeId === "plan" ? "plan" : "code";
            return {};
        })
        .onNotification(methods.agent.session.cancel, async ({ params }) => {
            const state = sessions.get(params.sessionId);
            if (state === undefined) {
                return;
            }
            // Soft cancel, browser parity: abort the SSE fetch (the daemon turn may finish server-side; its
            // idle reaping covers it) — a daemon hard-cancel route is the listed follow-up.
            state.cancelled = true;
            state.abort?.abort();
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
            const config = requireConfig();
            const state = sessions.get(params.sessionId);
            if (state === undefined) {
                throw RequestError.invalidParams({ details: `unknown session ${params.sessionId}` });
            }
            const daemon = daemonFor(config);
            const prompt = params.prompt
                .map((block) => (block.type === "text" ? block.text : block.type === "resource_link" ? `@${block.uri}` : `[${block.type}]`))
                .join("");
            state.cancelled = false;
            state.abort = new AbortController();
            let failure: RequestError | undefined;
            try {
                const turn = daemon.streamTurn(
                    {
                        prompt,
                        agent: config.agent,
                        conversationId: state.conversationId,
                        ...(state.providerSessionId !== undefined ? { sessionId: state.providerSessionId } : {}),
                        ...(config.model !== undefined ? { model: config.model } : {}),
                        permissionMode: state.mode === "plan" ? "plan" : "bypassPermissions",
                    },
                    state.abort.signal,
                );
                for await (const event of turn) {
                    if (event.kind === "session") {
                        state.providerSessionId = event.sessionId;
                        persistSessions();
                        continue;
                    }
                    if (event.kind === "plan") {
                        await reviewPlan(ctx, params.sessionId, daemon, event);
                        continue;
                    }
                    if (event.kind === "question") {
                        await askQuestions(ctx, params.sessionId, daemon, event);
                        continue;
                    }
                    if (event.kind === "error") {
                        // Remember the failure but keep draining: the daemon streams `done` after error frames,
                        // and partial updates already rendered should not be interleaved with a hung stream.
                        failure = RequestError.internalError({ details: event.message });
                        continue;
                    }
                    if (event.kind === "done") {
                        break;
                    }
                    const update = sessionUpdateOf(event, state.cwd);
                    if (update !== undefined) {
                        await ctx.notify(methods.client.session.update, { sessionId: params.sessionId, update });
                    }
                }
            } catch (error) {
                if (state.cancelled) {
                    return { stopReason: "cancelled" };
                }
                throw error instanceof RequestError ? error : RequestError.internalError({ details: error instanceof Error ? error.message : "turn failed" });
            } finally {
                state.abort = undefined;
            }
            if (state.cancelled) {
                return { stopReason: "cancelled" };
            }
            if (failure !== undefined) {
                throw failure;
            }
            return { stopReason: "end_turn" };
        });
};
