import { WEBCHAT_DAILY_MAX_DEFAULT, type WebchatConfig, WebchatMessageSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { createPublicDoor, type PublicDoor, type PublicDoorSpec } from "../automations/public-door.js";
import { PAYLOAD_MAX, TITLE_MAX, type WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { type ThreadSession, WEBCHAT_SESSION_TTL_MS } from "../sessions/thread-sessions.js";
import type { InstallsStore } from "../store/installs.js";
import { statePath } from "../workspace/layout/state-paths.js";
import { createSseStream } from "./sse-stream.js";
import { publicConfig, usableAntiBot } from "./webchat-config.js";
import { resolveVisitor, SignInRequired, type VisitorIdentity } from "./webchat-identity.js";

// The Front Desk's ingest: a public door (automations/public-door.ts) whose verb is `message`, where every arrival is
// an agent turn. Somebody is waiting for an answer, so the reply streams back as SSE.

export const WEBCHAT_DOOR: PublicDoorSpec<WebchatConfig> = {
    provider: "webchat",
    slug: "webchat",
    configOf: (automation) => automation.webchat ?? {},
    publicConfig,
    missing: "no web-chat automation with that id",
    disabled: "automation disabled",
    rateMax: 20,
    challengeParam: "conversation",
    installs: (root) => statePath(root, ".intentic/records/webchat-installs.json"),
    conversationPrefix: "wc",
};

// One turn at a time per automation: concurrent visitor messages queue rather than drop, covering both the fire and the
// thread-session settle that follows it. Keyed by automation id; a job that throws still lets the next one run.
const queues = new Map<string, Promise<unknown>>();
const enqueue = (id: string, job: () => Promise<void>): Promise<void> => {
    const tail = (queues.get(id) ?? Promise.resolve()).then(job, job);
    queues.set(id, tail);
    void tail.finally(() => {
        if (queues.get(id) === tail) {
            queues.delete(id);
        }
    });
    return tail;
};

// What a refused message answers with: one shape for every gate, so the handler has exactly one way to say no.
type Refusal = { status: 400 | 401 | 403 | 404 | 409 | 413 | 429; error: string };

// The body, or the refusal; size is checked before JSON parse, since reading an oversized body first is the DoS this
// limit prevents.
const parsed = async (c: Context<AppEnv, "/webchat/:id/message">): Promise<Refusal | { body: z.infer<typeof WebchatMessageSchema> }> => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
        return { status: 413, error: "payload too large" };
    }
    try {
        return { body: WebchatMessageSchema.parse(await c.req.json()) };
    } catch {
        return { status: 400, error: "invalid message body" };
    }
};

interface Admitted {
    readonly automation: AutomationRecord;
    readonly visitor: VisitorIdentity;
    readonly thread: { readonly key: string; readonly conversationId: string };
    readonly ttlMs: number;
    // Whether this thread has spoken before: its first turn carries the widget's own history, later ones do not.
    readonly resumed: boolean;
}

// Who this is for, then who is asking: the door's gates, then the visitor's identity. A visitor who can't sign in to a
// sign-in-only Front Desk is refused here, before any challenge is spent.
const admitted = async (
    door: PublicDoor<WebchatConfig>,
    services: Services,
    c: Context<AppEnv, "/webchat/:id/message">,
    body: z.infer<typeof WebchatMessageSchema>,
    now: number,
): Promise<Refusal | { automation: AutomationRecord; config: WebchatConfig; visitor: VisitorIdentity }> => {
    const resolved = await door.resolve(c.req.param("id"), c.req.header("origin"));
    if ("status" in resolved) {
        return { status: resolved.status, error: resolved.error };
    }
    const { automation, config } = resolved;
    if (door.rateLimited(`${automation.id}:${body.conversationId}`, now)) {
        return { status: 429, error: "rate limited" };
    }
    try {
        return { automation, config, visitor: await resolveVisitor(services, config, body) };
    } catch (error) {
        if (error instanceof SignInRequired) {
            return { status: 401, error: "sign in to continue" };
        }
        throw error;
    }
};

// The ceilings between an admitted visitor and waking the agent, in the order that spends least: anti-bot once per
// thread (an existing session record is the proof), then the per-conversation ceiling, then the day's ceiling last.
const gated = async (
    door: PublicDoor<WebchatConfig>,
    services: Services,
    c: Context<AppEnv, "/webchat/:id/message">,
    body: z.infer<typeof WebchatMessageSchema>,
    now: number,
): Promise<Refusal | Admitted> => {
    const who = await admitted(door, services, c, body, now);
    if ("error" in who) {
        return who;
    }
    const { automation, config, visitor } = who;
    const ttlMs = (config.sessionTtlMinutes ?? 0) * 60_000 || WEBCHAT_SESSION_TTL_MS;
    const thread = door.thread(automation.id, body.conversationId);
    const existing = await services.threadSessions.get(thread.key, ttlMs, now);
    if (existing === undefined && !(await door.antiBotPassed(usableAntiBot(config), config, body, body.conversationId, c, now))) {
        return { status: 403, error: "bot check failed" };
    }
    return overCeiling(door, automation, config, existing, now) ?? { automation, visitor, thread, ttlMs, resumed: existing?.sessionId !== undefined };
};

// The two spend ceilings, the conversation's lifetime one and the automation's day, in that order.
const overCeiling = (
    door: PublicDoor<WebchatConfig>,
    automation: AutomationRecord,
    config: WebchatConfig,
    existing: ThreadSession | undefined,
    now: number,
): Refusal | undefined => {
    if (existing !== undefined && config.conversationMessageMax !== undefined && existing.messages >= config.conversationMessageMax) {
        return { status: 429, error: "this conversation has reached its message limit" };
    }
    if (door.overDailyCeiling(automation.id, config.dailyMessageMax ?? WEBCHAT_DAILY_MAX_DEFAULT, now)) {
        return { status: 429, error: "this chat has reached today's limit, try again tomorrow" };
    }
    return undefined;
};

export const createWebchatRoutes = (services: Services, wake: WakeFn = streamAgent, installs?: InstallsStore) => {
    const door = createPublicDoor(services, WEBCHAT_DOOR, installs);
    return {
        ...door.routes,
        message: async (c: Context<AppEnv, "/webchat/:id/message">): Promise<Response> => {
            const now = Date.now();
            const read = await parsed(c);
            if ("error" in read) {
                return c.json({ error: read.error }, read.status);
            }
            const { body } = read;
            const gate = await gated(door, services, c, body, now);
            if ("error" in gate) {
                return c.json({ error: gate.error }, gate.status);
            }
            const { automation, visitor, thread, ttlMs } = gate;

            // Content is the visitor's text; identity sits in separate fields, only `verified` signature-backed, so it
            // can't self-promote.
            const payload = JSON.stringify({
                conversationId: body.conversationId,
                author: visitor.author,
                content: body.content,
                ...(visitor.verified !== undefined ? { verified: visitor.verified } : {}),
                ...(visitor.displayName !== undefined ? { unverifiedDisplayName: visitor.displayName } : {}),
                ...(visitor.member === true ? { member: true } : {}),
                ...(!gate.resumed && body.history !== undefined ? { history: body.history } : {}),
            });

            // Logs the inbound request; fireAutomation logs the run and reply itself.
            void services.activity
                .append({
                    provider: "webchat",
                    direction: "in",
                    type: "message.received",
                    channelId: body.conversationId,
                    author: visitor.author,
                    content: body.content,
                    automationIds: [automation.id],
                })
                .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));

            return streamSSE(c, async (sse) => {
                const stream = createSseStream(sse);
                // Approval-gated automations send a pending notice and hold the wake; auto ones stream live. An
                // approved run lands in this conversation, but by then this SSE is closed, so the reply reaches the
                // fleet, not the widget.
                if (automation.requireApproval === true) {
                    await sse.writeSSE({ event: "pending", data: "Thanks, your request was received and a human will review it shortly." });
                }
                await enqueue(automation.id, async () => {
                    await door.fireOnThread(automation, thread, ttlMs, wake, {
                        payload,
                        // The queue above serializes this route's turns; this guards against everyone else's (approved
                        // wakes, restarts).
                        overlap: "queue",
                        stream: stream.turn,
                        origin: { automationId: automation.id, provider: "webchat", channelId: body.conversationId, author: visitor.author },
                        title: `${visitor.author}: ${body.content}`.slice(0, TITLE_MAX),
                        ...(automation.allowedTools !== undefined ? { allowedTools: automation.allowedTools } : {}),
                    });
                }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "web-chat wake failed"));
                await stream.flushed();
            });
        },
    };
};
