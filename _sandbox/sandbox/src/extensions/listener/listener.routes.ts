import {
    LISTENER_DISPATCH_KEY_HEADER,
    type ListenerDispatchFrame,
    type ListenerMessage,
    ListenerMessageSchema,
    type ListenerState,
    type ListenerStatus,
    ListenerStatusSchema,
    type ListenerStopAnswer,
    ListenerStopSchema,
} from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { Context } from "hono";
import { DEBOUNCE_MS, dispatchListenerMessage, listenerOriginOf, reportListenerFailure, stopChannelTurn } from "../../automations/listeners.js";
import { PAYLOAD_MAX } from "../../automations/fire/run-fire.js";
import type { TurnStream } from "../../automations/fire/fire-options.js";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { callingExtension, type ExtensionGrant } from "../../auth/grants.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { listenerOwnership, listenerStateOf } from "./listener-state.js";
import { setListenerStatus } from "../../capabilities/status/listener-status.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { admitOnce } from "./dispatch-keys.js";
import { channelAnswerSink } from "./listener-outbox.js";

// Control surface for an extension's listener gateway; the gateway holds the provider connection, not the daemon.
// Five routes: /state (reconcile), /dispatch (inbound events, optional ndjson stream), failure/status reports, and /stop
// (a person in the channel stopping a turn the channel started).
// Each answers only the extension token of the extension that owns this provider's listener (listener-state.ts): /state
// hands back connector credentials, and the others would let a stranger fake inbound messages that wake turns, or mark
// that provider's automations. Declaring the provider is not enough, since a second extension can declare it too; the
// owner is resolved at request time by the one rule. The grant table admits nothing else (panel: false, control:
// "never"); the handler checks again, for a loopback daemon.

// A stop names a conversation and a person: a few hundred bytes, never more than this.
const STOP_BODY_MAX = 4_096;

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

// One message dispatched with its turns' frames streamed back as ndjson. The frames go into a pipe the response reads,
// and the response is answered only once the message is admitted: its 200 is the gateway's word that the message is
// durably in the inbox (the contract's dispatch key note).
const streamedDispatch = async (services: Services, message: ListenerMessage, key: string | undefined): Promise<Response> => {
    const pipe = new TransformStream<string, string>();
    const writer = pipe.writable.getWriter();
    let tail: Promise<unknown> = Promise.resolve();
    const writeLine = (line: string): void => {
        // allow(silent-catch): a gateway that hung up takes no more frames, and the turn goes on without it
        tail = tail.then(() => writer.write(`${line}\n`)).catch(() => {});
    };
    const sinks = new Map<string, Promise<void>>();
    const makeStream = (automationId: string): TurnStream => {
        const gate = Promise.withResolvers<void>();
        sinks.set(automationId, gate.promise);
        const write = (frame: ListenerDispatchFrame): void => writeLine(JSON.stringify(frame));
        return {
            delta: (text) => {
                if (text !== "") {
                    write({ automationId, delta: text });
                }
            },
            // Forwarded verbatim, unlike the Visitor chat's: it lands in the owner's channel, sentence intact.
            failed: (reason) => write({ automationId, failed: reason }),
            opened: (turn) => write({ automationId, opened: turn }),
            step: (step) => write({ automationId, step }),
            plan: (plan) => write({ automationId, plan }),
            held: (reason) => write({ automationId, held: reason }),
            queued: (reason) => write({ automationId, queued: reason }),
            steered: () => write({ automationId, steered: true }),
            end: () => {
                write({ automationId, end: true });
                void tail.finally(gate.resolve);
            },
        };
    };
    // A repeat of an admitted key streams nothing: the first request's stream carries that message's turns.
    const matched = (await admitOnce(services, message.provider, key, () => dispatchListenerMessage(services, message, DEBOUNCE_MS, makeStream))) ?? [];
    void Promise.all(matched.map((id) => sinks.get(id) ?? Promise.resolve()))
        .then(() => tail)
        // allow(silent-catch): closing a pipe the gateway already hung up on has nobody left to tell
        .finally(() => writer.close().catch(() => {}));
    return new Response(pipe.readable.pipeThrough(new TextEncoderStream()), { headers: { "content-type": "application/x-ndjson" } });
};

export const createListenerRoutes = (services: Services) => ({
    // Reconcile feed: enabled listener automations plus the calling extension's own connector configs (bot tokens
    // included); polled to connect.
    state: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
        // Held to the contract's feed shape, which the gateway parses with (connector-runtime's daemon client).
        const state: ListenerState = await listenerStateOf(services, c.req.param("provider"), caller.id);
        return c.json(state);
    },

    // One inbound event routed to matching listener automations; plain calls answer once it is admitted.
    // `?stream=1` holds an ndjson response, one frame stream per matched automation, closed once every turn ends.
    // A request naming a key the daemon admitted lately is answered without admitting it again (dispatch-keys.ts).
    dispatch: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
        const provider = c.req.param("provider");
        // Counted as it arrives: a chunked body declares no length, and would otherwise be read whole first.
        const body = await readBoundedJson(c.req.raw, PAYLOAD_MAX);
        if (body.kind === "tooLarge") {
            return c.json({ error: "payload too large" }, 413);
        }
        const parsed = body.kind === "ok" ? ListenerMessageSchema.safeParse(body.value) : undefined;
        if (parsed === undefined || !parsed.success) {
            return c.json({ error: "invalid listener message" }, 400);
        }
        const message: ListenerMessage = parsed.data;
        if (message.provider !== provider) {
            return c.json({ error: "provider mismatch" }, 400);
        }
        const key = c.req.header(LISTENER_DISPATCH_KEY_HEADER);
        if (c.req.query("stream") !== "1") {
            // A message whose live stream died with the gateway, retried: its answer goes into its thread, as a held wake's.
            const answerSink =
                c.req.query("answer") === "channel" ? (automationId: string) => channelAnswerSink(services, listenerOriginOf(message, automationId))?.stream : undefined;
            await admitOnce(services, provider, key, () => dispatchListenerMessage(services, message, DEBOUNCE_MS, answerSink));
            return c.json({ ok: true });
        }
        return streamedDispatch(services, message, key);
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

    // A person in the channel pressing Stop: the turn stops only for someone the automation's sender rules let talk to
    // it unreleased, and only on a conversation this provider's channel started.
    stop: async (c: Context<AppEnv, "/listeners/:provider">): Promise<Response> => {
        const caller = await listenerCaller(services, c);
        if (caller instanceof Response) {
            return caller;
        }
        const read = await readBoundedJson(c.req.raw, STOP_BODY_MAX);
        const body = read.kind === "ok" ? ListenerStopSchema.safeParse(read.value) : undefined;
        if (body === undefined || !body.success) {
            return c.json({ error: "invalid stop body" }, 400);
        }
        const answer: ListenerStopAnswer = await stopChannelTurn(services, c.req.param("provider"), body.data);
        return c.json(answer);
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

// Realtime-listener control for an extension's gateway process: reconciles via /state, POSTs inbound events to
// /dispatch, reports failures/status.
// Reached with the per-boot panel token, like every other panel-process call.
export const listenerRawRoutes = defineRawRoutes((services: Services) => {
    const listenerRoutes = createListenerRoutes(services);
    return {
        "GET /listeners/{provider}/state": listenerRoutes.state,
        "POST /listeners/{provider}/dispatch": listenerRoutes.dispatch,
        "POST /listeners/{provider}/failure": listenerRoutes.failure,
        "POST /listeners/{provider}/status": listenerRoutes.status,
        "POST /listeners/{provider}/stop": listenerRoutes.stop,
    };
});
