import { type ListenerDispatchFrame, type ListenerMessage, ListenerMessageSchema, type ListenerStatus, ListenerStatusSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { streamAgent } from "../agent/agent.routes.js";
import { DEBOUNCE_MS, dispatchListenerMessage, reportListenerFailure } from "../automations/listeners.js";
import { PAYLOAD_MAX, type TurnStream, type WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { listenerState } from "./listener-state.js";
import { setListenerStatus } from "./listener-status.js";

// The control surface for an extension's realtime-listener gateway process (e.g. ext-discord). The daemon holds
// no provider connection itself — the gateway does — so these four routes are the seam: the gateway reconciles
// via /state, POSTs inbound events to /dispatch (holding an ndjson turn-stream when it wants the reply painted),
// and reports fatal failures + live status. All are reached with the per-boot panel token (app.ts's
// x-intentic-panel branch), server-side only, so /state returning connector secrets is not a new exposure.

export const createListenerRoutes = (services: Services, wake: WakeFn = streamAgent) => ({
    // The reconcile feed: the enabled listener automations for this provider + its connector capabilities WITH
    // full config (secret bot tokens included — the gateway needs them to connect). The gateway polls this on
    // its interval and connects/disconnects to match.
    state: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => c.json(await listenerState(services, c.req.param("provider"))),

    // One inbound event → the matching listener automations. Plain (voice events, or a source painting its own
    // reply): fire-and-return. `?stream=1`: hold an ndjson response, one frame stream per matched automation
    // tagged by automationId ({automationId, delta} … {automationId, end}), so the gateway paints each reply into
    // its channel; the response closes once every matched turn has ended (the batcher's end-on-replace and the
    // disabled-automation end() above guarantee each sink terminates).
    dispatch: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const provider = c.req.param("provider");
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
        }
        let message: ListenerMessage;
        try {
            message = ListenerMessageSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid listener message" }, 400);
        }
        if (message.provider !== provider) {
            return c.json({ error: "provider mismatch" }, 400);
        }
        if (c.req.query("stream") !== "1") {
            await dispatchListenerMessage(services, message, wake);
            return c.json({ ok: true });
        }
        c.header("content-type", "application/x-ndjson");
        return stream(c, async (ndjson) => {
            const sinks = new Map<string, Promise<void>>();
            const makeStream = (automationId: string): TurnStream => {
                const gate = Promise.withResolvers<void>();
                sinks.set(automationId, gate.promise);
                let tail: Promise<unknown> = Promise.resolve();
                const write = (frame: ListenerDispatchFrame): void => {
                    tail = tail.then(() => ndjson.writeln(JSON.stringify(frame))).catch(() => {});
                };
                return {
                    delta: (text) => {
                        if (text !== "") {
                            write({ automationId, delta: text });
                        }
                    },
                    // Forwarded VERBATIM, unlike the Doorbell's: a gateway delivers into the owner's own
                    // channel, so the provider's actual sentence is the useful thing to put there rather than
                    // something neutral. What a source does with the frame is the source's own call.
                    failed: (reason) => write({ automationId, failed: reason }),
                    end: () => {
                        write({ automationId, end: true });
                        void tail.finally(gate.resolve);
                    },
                };
            };
            const matched = await dispatchListenerMessage(services, message, wake, DEBOUNCE_MS, makeStream);
            await Promise.all(matched.map((id) => sinks.get(id) ?? Promise.resolve()));
        });
    },

    // A fatal source failure (bad credential, missing portal intent): surface it on the provider's automations +
    // the activity feed, exactly as the in-process source's own reporting did.
    failure: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const provider = c.req.param("provider");
        const body = (await c.req.json().catch(() => undefined)) as { detail?: unknown } | undefined;
        await reportListenerFailure(services, provider, typeof body?.detail === "string" ? body.detail : "listener failure");
        return c.json({ ok: true });
    },

    // The gateway's periodic live status → the map the /activity/status probe reads (the daemon no longer holds
    // the connection to probe directly).
    status: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const provider = c.req.param("provider");
        let body: ListenerStatus;
        try {
            body = ListenerStatusSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid status body" }, 400);
        }
        setListenerStatus(provider, body, Date.now());
        return c.json({ ok: true });
    },
});
