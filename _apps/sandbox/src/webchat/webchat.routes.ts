import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { streamAgent } from "../agent/agent.routes.js";
import { fireAutomation, PAYLOAD_MAX, type WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { createSseStream } from "./sse-stream.js";

// The embeddable web-chat widget's ingest: an anonymous website visitor POSTs a message here and the agent's
// reply streams back over SSE. Unlike Discord (a daemon-held gateway) the transport is inbound HTTP, so THIS
// route is the "source" — it normalizes the message and drives fireAutomation directly, reusing the automation's
// guard, requireApproval gate, run history, and activity log unchanged.

const WebchatMessageSchema = z.object({
    conversationId: z.string().min(1).max(200),
    content: z.string().min(1),
    author: z.string().max(200).optional(),
    // Recent prior turns the widget already holds client-side, injected so the model has thread context. Server
    // -side session threading is a later step; for now the client supplies its own history.
    history: z
        .array(z.object({ author: z.string().optional(), content: z.string() }))
        .max(50)
        .optional(),
});

// A web-chat automation runs ONE turn at a time: concurrent visitor messages QUEUE instead of overlapping, so
// the shared working tree is never edited by two turns at once and no request is dropped — fireAutomation's own
// inFlight guard DROPS overlaps, which is wrong for support where every message must be answered. Keyed by
// automation id; a job that throws still lets the next one run (.then(job, job)).
// ponytail: serial per automation — fine for one sandbox's support load. Parallelize per conversation only if
// it matters, by isolating each turn in its own git worktree/session (v2).
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

export const createWebchatRoute =
    (services: Services, wake: WakeFn = streamAgent) =>
    async (c: Context<AppEnv, "/webchat/:id/message">): Promise<Response> => {
        const automation = await services.automations.get(c.req.param("id"));
        if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== "webchat") {
            return c.json({ error: "no web-chat automation with that id" }, 404);
        }
        // The public id is the address; the embed-origin allowlist (plus the rate limit below) is the real gate —
        // CORS only keeps browsers from blocking a legit widget. A non-browser client omits Origin and is refused.
        const origin = c.req.header("origin");
        if (origin === undefined || !(automation.trigger.allowedOrigins ?? []).includes(origin)) {
            return c.json({ error: "origin not allowed" }, 403);
        }
        if (!automation.enabled) {
            return c.json({ error: "automation disabled" }, 409);
        }
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
        const author = body.author ?? "visitor";
        if (rateLimited(`${automation.id}:${body.conversationId}`, Date.now())) {
            return c.json({ error: "rate limited" }, 429);
        }
        const payload = JSON.stringify({
            conversationId: body.conversationId,
            author,
            content: body.content,
            ...(body.history !== undefined ? { history: body.history } : {}),
        });
        // Log the inbound request like the listener dispatcher does — fireAutomation logs the run + reply itself.
        void services.activity
            .append({
                provider: "webchat",
                direction: "in",
                type: "message.received",
                channelId: body.conversationId,
                author,
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
            await enqueue(automation.id, () => fireAutomation(services, automation, payload, wake, false, stream.turn)).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "web-chat wake failed"),
            );
            await stream.flushed();
        });
    };
