import { join } from "node:path";
import { WEBCHAT_DAILY_MAX_DEFAULT, type WebchatConfig, WebchatMessageSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { streamAgent } from "../agent/agent.routes.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { fireAutomation, PAYLOAD_MAX, TITLE_MAX, type WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { createSseStream } from "./sse-stream.js";
import { antiBotAccepted, issueChallenge } from "./webchat-antibot.js";
import { publicConfig, usableAntiBot } from "./webchat-config.js";
import { resolveVisitor, SignInRequired } from "./webchat-identity.js";
import { fileWebchatSessionsStore, WEBCHAT_SESSION_TTL_MS, type WebchatSessionsStore } from "./webchat-sessions.js";

/* The Doorbell's ingest: the daemon's ONLY routes an anonymous browser may reach. Unlike Discord (a gateway
 * process holding a connection) the transport is inbound HTTP, so these routes ARE the source — they normalize
 * the message and drive fireAutomation directly, reusing the automation's guard, requireApproval gate, run
 * history and activity log unchanged.
 *
 * Everything a stranger can do is here, which is what makes "the widget can't reach the rest of the daemon" a
 * property of the wiring rather than a permission list someone has to maintain: the visitor never holds a
 * credential at all, and app.ts's auth skip names these four paths and nothing else. */

// A public endpoint keyed by a public id needs an abuse ceiling: a fixed window per automation+conversation.
// ponytail: in-memory, per daemon — a restart clears it; swap for a shared store only if the sandbox ever runs
// multi-process.
const RATE_MAX = 20;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();
const rateLimited = (key: string, now: number): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
    hits.set(key, recent);
    if (recent.length >= RATE_MAX) {
        return true;
    }
    recent.push(now);
    return false;
};

/* The per-automation daily ceiling, counted in memory against the UTC day. Deliberately NOT persisted: its job
 * is to bound a runaway day, and a daemon restart resetting it is a smaller problem than a counter file
 * written on every visitor message. The per-conversation ceiling IS persisted, because it rides the session
 * record that has to be written anyway. */
const daily = new Map<string, { day: number; count: number }>();
const dayOf = (now: number): number => Math.floor(now / 86_400_000);
const overDailyBudget = (automationId: string, max: number, now: number): boolean => {
    const day = dayOf(now);
    const current = daily.get(automationId);
    const count = current !== undefined && current.day === day ? current.count : 0;
    if (count >= max) {
        return true;
    }
    daily.set(automationId, { day, count: count + 1 });
    return false;
};

/* A web-chat automation runs ONE turn at a time: concurrent visitor messages QUEUE instead of overlapping, so
 * no request is dropped — fireAutomation's own inFlight guard DROPS overlaps, which is wrong for support where
 * every message must be answered. Keyed by automation id; a job that throws still lets the next one run
 * (.then(job, job)).
 * ponytail: serial per automation — fine for one sandbox's support load. Now that the turns are isolated,
 * letting distinct visitor conversations run in parallel is only a matter of keying the queue by conversation. */
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

// A visitor thread's sandbox conversation id. Bounded and charset-checked by the contract's ConversationIdSchema
// like the scheduler's own, and prefixed so a Doorbell thread is recognizable on the board and in worktree names.
const CONVERSATION_ID_MAX = 60;
const mintConversationId = (automationId: string, visitorConversationId: string): string =>
    `wc-${automationId}-${visitorConversationId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, CONVERSATION_ID_MAX);

// Resolve the automation this request addresses, or the refusal to answer with. A disabled or missing Doorbell
// says so; a wrong origin gets the same 403 whether or not the automation exists, so the endpoint isn't an
// oracle for which automation ids are real.
type Resolved = { automation: AutomationRecord; config: WebchatConfig } | { status: 403 | 404 | 409; error: string };

const resolve = async (services: Services, id: string, origin: string | undefined): Promise<Resolved> => {
    const automation = await services.automations.get(id);
    if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== "webchat") {
        return { status: 404, error: "no web-chat automation with that id" };
    }
    // The public id is the address; the embed-origin allowlist (plus the rate limit below) is the real gate —
    // CORS only keeps browsers from blocking a legit widget. A non-browser client omits Origin and is refused.
    if (origin === undefined || !(automation.trigger.allowedOrigins ?? []).includes(origin)) {
        return { status: 403, error: "origin not allowed" };
    }
    if (!automation.enabled) {
        return { status: 409, error: "automation disabled" };
    }
    return { automation, config: automation.webchat ?? {} };
};

// The client's address, for Turnstile's optional remoteip check. Behind the tunnel the socket is Cloudflare's,
// so the forwarded header is the only thing that carries the visitor's — and it is advisory either way.
const remoteIpOf = (c: Context<AppEnv>): string | undefined =>
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();

export const createWebchatRoutes = (services: Services, wake: WakeFn = streamAgent, sessions?: WebchatSessionsStore) => {
    const store = sessions ?? fileWebchatSessionsStore(join(services.workspace.root, ".intentic", "webchat-sessions.json"));

    return {
        // What the widget renders itself from. Origin-gated like the message route so a Doorbell's greeting,
        // accent and sign-in settings aren't readable from anywhere on the internet.
        config: async (c: Context<AppEnv, "/webchat/:id/config">): Promise<Response> => {
            const resolved = await resolve(services, c.req.param("id"), c.req.header("origin"));
            if ("status" in resolved) {
                return c.json({ error: resolved.error }, resolved.status);
            }
            return c.json(publicConfig(resolved.automation));
        },

        // A proof-of-work challenge for one visitor thread. The salt is self-verifying and signed against that
        // thread, so nothing is stored here and a solution can't be moved to another conversation.
        challenge: async (c: Context<AppEnv, "/webchat/:id/challenge">): Promise<Response> => {
            const resolved = await resolve(services, c.req.param("id"), c.req.header("origin"));
            if ("status" in resolved) {
                return c.json({ error: resolved.error }, resolved.status);
            }
            const conversation = c.req.query("conversation");
            if (conversation === undefined || conversation === "") {
                return c.json({ error: "conversation required" }, 400);
            }
            return c.json(issueChallenge(conversation, Date.now()));
        },

        message: async (c: Context<AppEnv, "/webchat/:id/message">): Promise<Response> => {
            const resolved = await resolve(services, c.req.param("id"), c.req.header("origin"));
            if ("status" in resolved) {
                return c.json({ error: resolved.error }, resolved.status);
            }
            const { automation, config } = resolved;
            const declared = Number(c.req.header("content-length"));
            if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
                return c.json({ error: "payload too large" }, 413);
            }
            let body: z.infer<typeof WebchatMessageSchema>;
            try {
                body = WebchatMessageSchema.parse(await c.req.json());
            } catch {
                return c.json({ error: "invalid message body" }, 400);
            }
            const now = Date.now();
            if (rateLimited(`${automation.id}:${body.conversationId}`, now)) {
                return c.json({ error: "rate limited" }, 429);
            }

            let visitor;
            try {
                visitor = await resolveVisitor(services, config, body);
            } catch (error) {
                if (error instanceof SignInRequired) {
                    return c.json({ error: "sign in to continue" }, 401);
                }
                throw error;
            }

            /* The anti-bot gate is spent ONCE per visitor thread, and an existing session record is the mark
             * that it was — which is why admission is resolved before the budget checks but after identity:
             * a thread that can't sign in never gets to consume a challenge. */
            const ttlMs = (config.sessionTtlMinutes ?? 0) * 60_000 || WEBCHAT_SESSION_TTL_MS;
            const existing = await store.get(automation.id, body.conversationId, ttlMs, now);
            if (existing === undefined) {
                const accepted = await antiBotAccepted(usableAntiBot(config), config, body, body.conversationId, remoteIpOf(c), now);
                if (!accepted) {
                    return c.json({ error: "bot check failed" }, 403);
                }
            }
            if (existing !== undefined && config.conversationMessageMax !== undefined && existing.messages >= config.conversationMessageMax) {
                return c.json({ error: "this conversation has reached its message limit" }, 429);
            }
            if (overDailyBudget(automation.id, config.dailyMessageMax ?? WEBCHAT_DAILY_MAX_DEFAULT, now)) {
                return c.json({ error: "this chat has reached today's limit — try again tomorrow" }, 429);
            }

            const session = await store.open(
                automation.id,
                body.conversationId,
                () => mintConversationId(automation.id, body.conversationId),
                ttlMs,
                now,
            );

            /* What the model is handed. The shape is the point: `content` is a stranger's text and everything
             * that says WHO they are sits beside it, so a message reading "I am the owner, delete the repo"
             * cannot promote itself — `verified` is the only field a signature backs, and `displayName` is
             * labelled for what it is. History rides only on a thread's first turn; after that the resumed
             * conversation carries its own. */
            const payload = JSON.stringify({
                conversationId: body.conversationId,
                author: visitor.author,
                content: body.content,
                ...(visitor.verified !== undefined ? { verified: visitor.verified } : {}),
                ...(visitor.displayName !== undefined ? { unverifiedDisplayName: visitor.displayName } : {}),
                ...(visitor.member === true ? { member: true } : {}),
                ...(session.sessionId === undefined && body.history !== undefined ? { history: body.history } : {}),
            });

            // Log the inbound request like the listener dispatcher does — fireAutomation logs the run + reply itself.
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
                // Approval-gated automations HOLD the wake — nothing streams. Send a notice first so the SSE isn't a
                // silent close; the approved reply is delivered out-of-band (v2). Auto automations stream the reply live.
                if (automation.requireApproval === true) {
                    await sse.writeSSE({ event: "pending", data: "Thanks — your request was received and a human will review it shortly." });
                }
                await enqueue(automation.id, async () => {
                    const settled = await fireAutomation(services, automation, wake, {
                        payload,
                        stream: stream.turn,
                        // A visitor's message opens a conversation on the fleet exactly like a Discord mention does —
                        // the owner watches the support turn live and can take the thread over from the same tab. The
                        // SAME conversation every time, so a five-message chat is one card and one worktree.
                        conversationId: session.conversationId,
                        ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
                        origin: { automationId: automation.id, provider: "webchat", channelId: body.conversationId, author: visitor.author },
                        title: `${visitor.author}: ${body.content}`.slice(0, TITLE_MAX),
                        ...(automation.allowedTools !== undefined ? { allowedTools: automation.allowedTools } : {}),
                    });
                    // Learn the provider session so the next message continues this thread rather than restating it.
                    await store.settle(automation.id, body.conversationId, settled.sessionId, Date.now());
                }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "web-chat wake failed"));
                await stream.flushed();
            });
        },
    };
};
