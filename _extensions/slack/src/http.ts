import { createHmac, timingSafeEqual } from "node:crypto";
import { within } from "@intentic/base/async";
import { parseJsonWith } from "@intentic/base/json";
import { recentKeys } from "@intentic/connector-runtime";
import type { Logger } from "@intentic/connector-runtime";
import type { SlackConnection } from "./client.js";
import type { SlackBlockActions, SlackEnvelope, SlackEventsBody } from "./listener.js";
import { z } from "zod";

// SLACK'S HTTP MODE (2026-11-27): what Slack POSTs to the app's Request URLs, for a sandbox the platform hosts. That
// sandbox sleeps when nobody uses it and a Socket Mode connection sleeps with it, so its app sends its events and button
// presses to the `events` public route's wake URL instead (app-manifest.ts); one that arrives while it sleeps wakes it,
// and Slack's retry is what reaches here. The extension's backend (server.ts) hands each call on to the gateway's
// loopback unread, and this checks it and turns it into the envelope Socket Mode would have delivered, so the listener
// (listener.ts) answers it the same way: the dispatch spool, the shared chat reply, Stop, ⏹️ and steering.
// - Signed: `X-Slack-Signature` is an HMAC-SHA256 over `v0:<timestamp>:<body>` with the app's signing secret, which
//   only the Slack card holds; a request older than five minutes is refused, so a captured one cannot be replayed.
// - `url_verification`, which Slack sends when a Request URL is set, is answered with its challenge before anything
//   else: the app is usually being created then, before its signing secret is on the card, and the answer only echoes a
//   short token the caller sent.
// - Acked within Slack's three seconds: once what the event carries is kept, as Socket Mode's envelope is, or after
//   HTTP_ACK_MS whatever happens, leaving the edge and the backend's hop room before Slack gives up.
// - Slack retries an event it got no answer to (at once, after a minute, after five): a retry of an event already
//   taken, by its `event_id`, is acked and not dispatched again.

export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_RETRY_NUM_HEADER = "x-slack-retry-num";
const SLACK_RETRY_REASON_HEADER = "x-slack-retry-reason";

// The headers the backend hands on with the body: all this reads.
export const FORWARDED_HEADERS = ["content-type", SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER, SLACK_RETRY_NUM_HEADER, SLACK_RETRY_REASON_HEADER] as const;

// The gateway's loopback path the backend forwards a call through the public route to.
export const GATEWAY_EVENTS_PATH = "/slack/events";

// Slack's own advice: refuse a request whose timestamp is more than five minutes off.
export const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

// The answer goes back by then, kept or not, which leaves the hops between Slack and here most of a second of the three.
export const HTTP_ACK_MS = 2_000;

// A challenge as Slack mints them; anything else is not echoed.
const CHALLENGE = /^[\w-]{1,200}$/u;

export type SignatureCheck = "ok" | "stale" | "bad";

/** The `X-Slack-Signature` Slack sends for `body` at `timestamp`, signed with `secret`. */
export const slackSignature = (secret: string, timestamp: string, body: string): string =>
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;

/** Whether a request was signed with `secret`, and recently: "stale" for a genuine signature more than five minutes off. */
export const checkSlackSignature = (secret: string, timestamp: string | undefined, signature: string | undefined, body: string, now: number): SignatureCheck => {
    if (secret === "" || timestamp === undefined || !/^\d{1,12}$/u.test(timestamp) || signature === undefined) {
        return "bad";
    }
    const expected = Buffer.from(slackSignature(secret, timestamp, body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return "bad";
    }
    return Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_MAX_AGE_MS ? "stale" : "ok";
};

// What one call to the Request URL is: the URL check, an event, a button press, or something nothing here reads (Slack's
// `app_rate_limited`).
export type SlackHttpCall =
    | { readonly kind: "url_verification"; readonly challenge: string }
    | { readonly kind: "event"; readonly eventId: string | undefined; readonly body: SlackEventsBody }
    | { readonly kind: "interactive"; readonly body: SlackBlockActions }
    | { readonly kind: "other" };

// The shapes a call's body is read as. Slack names each by its `type`; only what decides the call is checked here, and
// the rest is handed on as Socket Mode hands it, for the listener to read.
const UrlVerificationSchema = z.object({ type: z.literal("url_verification"), challenge: z.string() });
const EventCallbackSchema = z.object({ type: z.literal("event_callback"), event_id: z.string().optional() }).loose();
// A button pressed on one of the app's messages, narrowed to what Stop reads; any other interactivity (a shortcut, a
// modal) reads as nothing here, as Socket Mode's would.
const BlockActionsSchema = z.object({
    type: z.literal("block_actions"),
    user: z.object({ id: z.string() }),
    channel: z.object({ id: z.string() }).optional(),
    message: z.object({ ts: z.string(), thread_ts: z.string().optional() }).optional(),
    actions: z.array(z.object({ action_id: z.string() })),
});
const JsonCallSchema = z.union([UrlVerificationSchema, EventCallbackSchema]);

/** What a call's body is: an interactivity payload arrives form-encoded (`payload=<json>`), everything else as JSON. */
export const readSlackCall = (contentType: string | undefined, body: string): SlackHttpCall => {
    if ((contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) {
        const payload: SlackBlockActions | undefined = parseJsonWith(new URLSearchParams(body).get("payload") ?? "", BlockActionsSchema);
        return payload === undefined ? { kind: "other" } : { kind: "interactive", body: payload };
    }
    const call = parseJsonWith(body, JsonCallSchema);
    if (call === undefined) {
        return { kind: "other" };
    }
    if (call.type === "url_verification") {
        return { kind: "url_verification", challenge: call.challenge };
    }
    // SAFETY: an `event_callback` is the body Socket Mode's `events_api` envelope carries.
    return { kind: "event", eventId: call.event_id, body: call as SlackEventsBody };
};

/** A `url_verification`'s answer, from the body alone: the challenge, or undefined for any other call or one not shaped like Slack's. */
export const challengeOf = (contentType: string | undefined, body: string): string | undefined => {
    const call = readSlackCall(contentType, body);
    return call.kind === "url_verification" && CHALLENGE.test(call.challenge) ? call.challenge : undefined;
};

export interface ForwardedCall {
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly body: string;
}

export interface HttpAnswer {
    readonly status: number;
    readonly body: string;
}

// A card whose app sends here: its id, and the signing secret its calls are checked against.
export interface SigningApp {
    readonly id: string;
    readonly signingSecret: string;
}

export interface SlackHttpIntakeDeps {
    // Every Slack card holding a signing secret, whether or not it is listening now; undefined until the gateway has read
    // the cards at all.
    readonly apps: () => readonly SigningApp[] | undefined;
    // The open connection of a card, when it is listening (an enabled Slack automation, its bot token accepted).
    readonly connection: (id: string) => SlackConnection | undefined;
    // Whether the gateway means to listen now (an enabled Slack automation), asked only of a card with no open connection.
    readonly listening: () => Promise<boolean>;
    // The listener's door: what Socket Mode's envelopes go through.
    readonly deliver: (connection: SlackConnection, envelope: SlackEnvelope) => void;
    readonly log: Logger;
    readonly now?: () => number;
    readonly ackWithinMs?: number;
}

const header = (headers: ForwardedCall["headers"], name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
};

const OK: HttpAnswer = { status: 200, body: "" };
// Nothing here can take the call yet: the gateway has not read its cards, or the card's connection is still opening, as
// right after a wake. Slack sends it again (the backend adds `Retry-After`).
const NOT_YET: HttpAnswer = { status: 503, body: "the Slack connection is starting" };

export interface SlackHttpIntake {
    readonly receive: (call: ForwardedCall) => Promise<HttpAnswer>;
}

export const createSlackHttpIntake = (deps: SlackHttpIntakeDeps): SlackHttpIntake => {
    const now = deps.now ?? Date.now;
    const ackWithin = deps.ackWithinMs ?? HTTP_ACK_MS;
    // Events taken, by card and `event_id`: a retry of one is acked and goes no further.
    const taken = recentKeys();

    // The card whose secret signed the call, or why none did.
    const signer = (call: ForwardedCall, apps: readonly SigningApp[]): SigningApp | "stale" | "bad" => {
        const timestamp = header(call.headers, SLACK_TIMESTAMP_HEADER);
        const signature = header(call.headers, SLACK_SIGNATURE_HEADER);
        let stale = false;
        for (const app of apps) {
            const check = checkSlackSignature(app.signingSecret, timestamp, signature, call.body, now());
            if (check === "ok") {
                return app;
            }
            stale ||= check === "stale";
        }
        return stale ? "stale" : "bad";
    };

    // Hands the envelope to the listener and answers once it is acked, or at the deadline whatever happens.
    const handOver = async (connection: SlackConnection, type: string, body: SlackEnvelope["body"]): Promise<HttpAnswer> => {
        let acked: () => void = () => undefined;
        const ack = new Promise<void>((resolve) => {
            acked = resolve;
        });
        deps.deliver(connection, { type, body, ack: async () => acked() });
        await within(ack, ackWithin, undefined, { unref: true });
        return OK;
    };

    // An event Slack sends again (`X-Slack-Retry-Num`) is taken once, by its `event_id`; one first heard on a retry
    // (it was sent while the sandbox slept) is taken then.
    const takeEvent = (connection: SlackConnection, app: SigningApp, event: Extract<SlackHttpCall, { kind: "event" }>, call: ForwardedCall): Promise<HttpAnswer> => {
        const retry = { eventId: event.eventId, retry: header(call.headers, SLACK_RETRY_NUM_HEADER), reason: header(call.headers, SLACK_RETRY_REASON_HEADER) };
        if (event.eventId !== undefined && taken.duplicate(`${app.id}:${event.eventId}`)) {
            deps.log.info(retry, "slack: a retry of an event already taken, acked");
            return Promise.resolve(OK);
        }
        if (retry.retry !== undefined) {
            deps.log.info(retry, "slack: heard an event on Slack's retry");
        }
        return handOver(connection, "events_api", event.body);
    };

    // What a call some card signed comes to: handed to that card's connection, or answered without one.
    const take = async (app: SigningApp, read: SlackHttpCall, call: ForwardedCall): Promise<HttpAnswer> => {
        if (read.kind !== "event" && read.kind !== "interactive") {
            return OK;
        }
        const connection = deps.connection(app.id);
        if (connection === undefined) {
            // A connection still opening while Slack automations are on (the sandbox just woke) cannot take it yet, so
            // Slack sends it again. With none on, nothing listens, as Socket Mode hears nothing then either: acked and let
            // go, so Slack never reads the silence as a broken URL.
            return (await deps.listening()) ? NOT_YET : OK;
        }
        return read.kind === "interactive" ? handOver(connection, "interactive", read.body) : takeEvent(connection, app, read, call);
    };

    return {
        receive: async (call) => {
            const contentType = header(call.headers, "content-type");
            const challenge = challengeOf(contentType, call.body);
            if (challenge !== undefined) {
                return { status: 200, body: challenge };
            }
            const apps = deps.apps();
            if (apps === undefined) {
                return NOT_YET;
            }
            const app = signer(call, apps);
            if (app === "stale" || app === "bad") {
                deps.log.warn({ why: app }, "slack: refused a call to the Request URL its signature does not vouch for");
                return { status: 401, body: app === "stale" ? "stale request" : "bad signature" };
            }
            return take(app, readSlackCall(contentType, call.body), call);
        },
    };
};
