import { WEBCHAT_DAILY_MAX_DEFAULT, type WebchatConfig, WebchatMessageSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import { streamAgent } from "../agent/agent.routes.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { fireAutomation, PAYLOAD_MAX, TITLE_MAX, type WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { dailyBudget } from "../store/daily-budget.js";
import { fileInstallsStore, type InstallsStore } from "../store/installs.js";
import { statePath } from "../workspace/state-paths.js";
import { createSseStream } from "./sse-stream.js";
import { antiBotAccepted, mintChallenge } from "../auth/antibot.js";
import { publicConfig, usableAntiBot } from "./webchat-config.js";
import { resolveVisitor, SignInRequired } from "./webchat-identity.js";
import { threadKey, WEBCHAT_SESSION_TTL_MS } from "../sessions/thread-sessions.js";

/* The Front Desk's ingest: the daemon's ONLY routes an anonymous browser may reach. Unlike Discord (a gateway
 * process holding a connection) the transport is inbound HTTP, so these routes ARE the source, they normalize
 * the message and drive fireAutomation directly, reusing the automation's guard, requireApproval gate, run
 * history and activity log unchanged.
 *
 * Everything a stranger can do is here, which is what makes "the widget can't reach the rest of the daemon" a
 * property of the wiring rather than a permission list someone has to maintain: the visitor never holds a
 * credential at all, and app.ts's auth skip names these four paths and nothing else. */

// A public endpoint keyed by a public id needs an abuse ceiling: a fixed window per automation+conversation.
// ponytail: in-memory, per daemon, a restart clears it; swap for a shared store only if the sandbox ever runs
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

// The per-automation daily ceiling, see daily-budget.ts for why it is in memory. The per-CONVERSATION ceiling
// is persisted instead, because it rides the thread session record that has to be written anyway.
const daily = dailyBudget();

/* A web-chat automation runs ONE turn at a time: concurrent visitor messages QUEUE instead of overlapping, so
 * no request is dropped, every message must be answered in support. This queue covers the whole job (the fire
 * AND the thread-session settle that must follow it); the fire additionally asks the scheduler to queue, which
 * is what keeps a visitor's turn from losing a race with a fire this route never started. Keyed by automation
 * id; a job that throws still lets the next one run (.then(job, job)).
 * ponytail: serial per automation, fine for one sandbox's support load. Now that the turns are isolated,
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
// like the scheduler's own, and prefixed so a Front Desk thread is recognizable on the board and in worktree names.
const CONVERSATION_ID_MAX = 60;
const mintConversationId = (automationId: string, visitorConversationId: string): string =>
    `wc-${automationId}-${visitorConversationId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, CONVERSATION_ID_MAX);

/* Resolve the automation this request addresses, or the refusal to answer with.
 *
 * A refusal carries the automation whenever one was found, because the install panel's most useful line is
 * built from exactly that case: a real Front Desk, asked for by an origin that is not on its list. Nothing about
 * the RESPONSE changes, the caller still answers with `status` and `error` alone. */
type Resolved = { automation: AutomationRecord; config: WebchatConfig } | { status: 403 | 404 | 409; error: string; automation?: AutomationRecord };

const resolve = async (services: Services, id: string, origin: string | undefined): Promise<Resolved> => {
    const automation = await services.automations.get(id);
    if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== "webchat") {
        return { status: 404, error: "no web-chat automation with that id" };
    }
    /* The public id is the address; the embed-origin allowlist (plus the rate limit below) is the real gate,
     * CORS only keeps browsers from blocking a legit widget. A non-browser client omits Origin and is refused.
     *
     * These statuses do tell an unknown id (404) from a real one asked for by the wrong origin (403). That is
     * deliberate rather than overlooked: an automation id is PUBLIC by construction, it sits in the embed
     * snippet on the customer's own page, so there is nothing for a uniform answer to protect, and the two
     * cases are the two different things a site owner has to fix. */
    if (origin === undefined || !(automation.trigger.allowedOrigins ?? []).includes(origin)) {
        return { status: 403, error: "origin not allowed", automation };
    }
    if (!automation.enabled) {
        return { status: 409, error: "automation disabled", automation };
    }
    return { automation, config: automation.webchat ?? {} };
};

// The client's address, for Turnstile's optional remoteip check. Behind the tunnel the socket is Cloudflare's,
// so the forwarded header is the only thing that carries the visitor's, and it is advisory either way.
const remoteIpOf = (c: Context<AppEnv>): string | undefined =>
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();

export const createWebchatRoutes = (
    services: Services,
    wake: WakeFn = streamAgent,
    installs: InstallsStore = fileInstallsStore(statePath(services.workspace.root, ".intentic/records/webchat-installs.json")),
) => {
    // The Front Desk is one PROVIDER of the shared thread store (services.threadSessions): its "channel" is the id
    // the widget minted for this visitor, so a five-message chat is one conversation exactly as a five-mention
    // Discord thread is.
    const store = services.threadSessions;

    return {
        /* What the widget renders itself from. Origin-gated like the message route so a Front Desk's greeting,
         * accent and sign-in settings aren't readable from anywhere on the internet.
         *
         * This is also the INSTALL PROBE: it is the one request every widget makes on every page load, so
         * recording it, admitted or refused, is what lets the app answer "did the snippet land?" instead of
         * showing the same empty run history for a working Front Desk and an unpasted one. */
        config: async (c: Context<AppEnv, "/webchat/:id/config">): Promise<Response> => {
            const origin = c.req.header("origin");
            const resolved = await resolve(services, c.req.param("id"), origin);
            if (origin !== undefined && resolved.automation !== undefined) {
                installs.record(resolved.automation.id, origin, !("status" in resolved), Date.now());
            }
            if ("status" in resolved) {
                return c.json({ error: resolved.error }, resolved.status);
            }
            return c.json(publicConfig(resolved.automation));
        },

        /* What the owner's install panel reads: which origins have actually loaded this Front Desk's widget, and
         * which were turned away. OWNER-ONLY, deliberately absent from app.ts's public webchat paths, so it
         * goes through the ordinary bearer middleware like every other route the app calls. */
        installs: async (c: Context<AppEnv, "/webchat/:id/installs">): Promise<Response> =>
            c.json({ origins: await installs.list(c.req.param("id")) }),

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
            return c.json(mintChallenge(conversation, Date.now()));
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
             * that it was, which is why admission is resolved before the budget checks but after identity:
             * a thread that can't sign in never gets to consume a challenge. */
            const ttlMs = (config.sessionTtlMinutes ?? 0) * 60_000 || WEBCHAT_SESSION_TTL_MS;
            const thread = threadKey("webchat", automation.id, body.conversationId);
            const existing = await store.get(thread, ttlMs, now);
            if (existing === undefined) {
                const accepted = await antiBotAccepted(usableAntiBot(config), config, body, body.conversationId, remoteIpOf(c), now);
                if (!accepted) {
                    return c.json({ error: "bot check failed" }, 403);
                }
            }
            if (existing !== undefined && config.conversationMessageMax !== undefined && existing.messages >= config.conversationMessageMax) {
                return c.json({ error: "this conversation has reached its message limit" }, 429);
            }
            if (daily.spend(automation.id, config.dailyMessageMax ?? WEBCHAT_DAILY_MAX_DEFAULT, now)) {
                return c.json({ error: "this chat has reached today's limit, try again tomorrow" }, 429);
            }

            const session = await store.open(thread, () => mintConversationId(automation.id, body.conversationId), ttlMs, now);

            /* What the model is handed. The shape is the point: `content` is a stranger's text and everything
             * that says WHO they are sits beside it, so a message reading "I am the owner, delete the repo"
             * cannot promote itself, `verified` is the only field a signature backs, and `displayName` is
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

            // Log the inbound request like the listener dispatcher does, fireAutomation logs the run + reply itself.
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
                /* Approval-gated automations HOLD the wake, nothing streams. Send a notice first so the SSE isn't
                 * a silent close; auto automations stream the reply live instead.
                 *
                 * The approved run lands in THIS visitor's conversation (the fire snapshots the thread onto the
                 * approval, and the approve route replays it), so the owner answers from the same card and the
                 * thread keeps its context. What is still missing is the last hop: this SSE is long closed by
                 * the time they approve, so the reply reaches the fleet and not the widget. Delivering it needs a
                 * channel the widget holds open across page loads, v2. */
                if (automation.requireApproval === true) {
                    await sse.writeSSE({ event: "pending", data: "Thanks, your request was received and a human will review it shortly." });
                }
                await enqueue(automation.id, async () => {
                    const settled = await fireAutomation(services, automation, wake, {
                        payload,
                        // The queue above serializes THIS route's turns; this serializes against everyone else's
                        // (an approved wake, a restart's re-fire), so a visitor's message is never the one dropped.
                        overlap: "queue",
                        stream: stream.turn,
                        // A visitor's message opens a conversation on the fleet exactly like a Discord mention does,
                        // the owner watches the support turn live and can take the thread over from the same tab. The
                        // SAME conversation every time, so a five-message chat is one card and one worktree.
                        conversationId: session.conversationId,
                        ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
                        origin: { automationId: automation.id, provider: "webchat", channelId: body.conversationId, author: visitor.author },
                        title: `${visitor.author}: ${body.content}`.slice(0, TITLE_MAX),
                        ...(automation.allowedTools !== undefined ? { allowedTools: automation.allowedTools } : {}),
                    });
                    // Learn the provider session so the next message continues this thread rather than restating it.
                    await store.settle(thread, settled.sessionId, Date.now());
                }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "web-chat wake failed"));
                await stream.flushed();
            });
        },
    };
};
