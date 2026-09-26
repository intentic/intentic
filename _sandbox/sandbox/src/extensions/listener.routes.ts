import {
    type ListenerDispatchFrame,
    type ListenerMessage,
    ListenerMessageSchema,
    type ListenerStatus,
    ListenerStatusSchema,
} from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { DEBOUNCE_MS, dispatchListenerMessage, reportListenerFailure } from "../automations/listeners.js";
import { PAYLOAD_MAX, type TurnStream } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { callingExtension, type ExtensionGrant } from "../auth/grants.js";
import { listenerOwnership, listenerStateOf } from "./listener-state.js";
import { setListenerStatus } from "./listener-status.js";

// Control surface for an extension's listener gateway; the gateway holds the provider connection, not the daemon.
// Four routes: /state (reconcile), /dispatch (inbound events, optional ndjson stream), and failure/status reports.
// Each answers only the extension token of the extension that owns this provider's listener (listener-state.ts): /state
// hands back connector credentials, and the others would let a stranger fake inbound messages that wake turns, or mark
// that provider's automations. Declaring the provider is not enough, since a second extension can declare it too; the
// owner is resolved at request time by the one rule. The grant table admits nothing else (panel: false, control:
// "never"); the handler checks again, for a loopback daemon.

// The calling extension when it owns this provider's listener; a Response refusing it otherwise.
const listenerCaller = async (services: Services, c: Context<AppEnv, "/listeners/:provider">): Promise<ExtensionGrant | Response> => {
    const caller = callingExtension(services.extensionBackend.verifyExtensionToken, (name) => c.req.header(name));
    if (caller === undefined) {
        return c.json({ error: "the listener routes answer an extension's own token only" }, 403);
    }
    const provider = c.req.param("provider");
    if (caller.listener !== provider) {
        return c.json({ error: `extension "${caller.id}" does not declare a listener for this provider` }, 403);
    }
    const owner = (await listenerOwnership(services)).owners.get(provider);
    return owner === caller.id ? caller : c.json({ error: `extension "${caller.id}" does not own this provider's listener` }, 403);
};

export const createListenerRoutes = (services: Services) => ({
    // Reconcile feed: enabled listener automations plus the calling extension's own connector configs (bot tokens
    // included); polled to connect.
    state: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
        return c.json(await listenerStateOf(services, c.req.param("provider"), caller.id));
    },

    // One inbound event routed to matching listener automations; plain calls fire-and-return.
    // `?stream=1` holds an ndjson response, one frame stream per matched automation, closed once every turn ends.
    dispatch: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
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
            await dispatchListenerMessage(services, message);
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
                    // Forwarded verbatim, unlike the Visitor chat's: it lands in the owner's channel, sentence intact.
                    failed: (reason) => write({ automationId, failed: reason }),
                    end: () => {
                        write({ automationId, end: true });
                        void tail.finally(gate.resolve);
                    },
                };
            };
            const matched = await dispatchListenerMessage(services, message, DEBOUNCE_MS, makeStream);
            await Promise.all(matched.map((id) => sinks.get(id) ?? Promise.resolve()));
        });
    },

    // Fatal source failure (bad credential, missing intent), surfaced on the provider's automations and activity feed.
    failure: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
        const provider = c.req.param("provider");
        const body = (await c.req.json().catch(() => undefined)) as { detail?: unknown } | undefined;
        await reportListenerFailure(services, provider, typeof body?.detail === "string" ? body.detail : "listener failure");
        return c.json({ ok: true });
    },

    // Gateway's periodic live status, into the map /activity/status reads; the daemon can't probe it directly.
    status: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
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
