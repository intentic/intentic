import type { PrivacyLedgerAction } from "@intentic/sandbox-contract/schemas/privacy";
import type { ShieldVerdict } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { BoundedMap } from "@intentic/base/held";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../../http/forward-headers.js";
import { GATEWAY_PATH, type PrivacyShield, type ShieldDecision } from "../privacy-shield.js";
import { type GatewayProtocol, protocolOf, restoreResponse, restoreStream, shieldRequest } from "./protocols/index.js";
import { compactAnthropicTools } from "./protocols/anthropic-tools.js";
import { isRecord, isText, type Json, toJson } from "./protocols/walk.js";
import type { Masker } from "../masker.js";
import { noteCoinedCall } from "./coined-calls.js";
import { emptyTally, maskingShield, watchingShield } from "./request-shield.js";
import type { GatewaySession } from "./session-token.js";
import type { RestoreText, ShieldTally } from "./shield-types.js";

// `ALL /privacy/gateway/<session>/*`: where every shielded runtime sends its model requests. The session names the
// provider and the upstream the runtime would otherwise have called; the request goes there with its own headers
// untouched (the runtime's credential travels as it would have), and only its body changes, as the shield's verdict
// (privacy-shield.ts `decide`) says: masked, watched (read and recorded, sent as it came), or relayed as it is. A request that cannot be masked is refused, never sent as it came. Every mode drops one thing from
// an Anthropic request, the dialect line of each tool's schema (protocols/anthropic-tools.ts), which no model reads.

export interface GatewayRouteDeps {
    readonly shield: PrivacyShield;
    readonly warn: (message: string, error?: unknown) => void;
    readonly fetch?: typeof fetch;
}

// Shaped like each wire's own error, so the runtime shows the sentence instead of a parse failure. A 400, not a 5xx: a
// runtime retries a server error, and a refusal does not get better by asking again.
const refusal = (protocol: GatewayProtocol | undefined, message: string): Response => {
    const body =
        protocol === "anthropic" || protocol === undefined
            ? { type: "error", error: { type: "invalid_request_error", message } }
            : { error: { message, type: "invalid_request_error", code: "privacy_shield" } };
    return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
};

const isJson = (type: string | null): boolean => type !== null && /^application\/([\w.+-]*\+)?json\b/iu.test(type);

// The request's bytes as the runtime sent them; none for a method that carries no body.
const requestBody = async (c: Context<AppEnv>): Promise<Uint8Array<ArrayBuffer> | undefined> =>
    c.req.method === "GET" || c.req.method === "HEAD" ? undefined : new Uint8Array(await c.req.arrayBuffer());

// What the relay sends of a body it does not mask: the same bytes, unless it is an Anthropic request whose tools carry a
// dialect line. Read only when the bytes name one, so every other request goes byte for byte as it came. A body the
// shield masks is replaced whole further on (maskedBody), so it is left as it came here.
const relayedBody = (masking: boolean, protocol: GatewayProtocol | undefined, contentType: string | null, raw: Uint8Array<ArrayBuffer> | undefined) => {
    if (masking || protocol !== "anthropic" || raw === undefined || !isJson(contentType)) {
        return raw;
    }
    const text = new TextDecoder().decode(raw);
    if (!text.includes('"$schema"')) {
        return raw;
    }
    try {
        const parsed = toJson(JSON.parse(text));
        const compacted = compactAnthropicTools(parsed);
        return compacted === parsed ? raw : new TextEncoder().encode(JSON.stringify(compacted));
    } catch {
        // allow(silent-catch): a body this cannot read is the provider's to refuse, exactly as it came.
        return raw;
    }
};

// The masked body as it goes, an Anthropic one less its tools' dialect lines like every relayed one.
const maskedBody = (protocol: GatewayProtocol, shielded: Json): Uint8Array<ArrayBuffer> =>
    new TextEncoder().encode(JSON.stringify(protocol === "anthropic" ? compactAnthropicTools(shielded) : shielded));

const isEventStream = (type: string | null): boolean => type !== null && /^text\/event-stream\b/iu.test(type);

// A request that leans on the provider's own record of the conversation (a Responses `previous_response_id`) carries
// only what is new, so what the model may write back is everything any request of its conversation gave it.
const isStateful = (protocol: GatewayProtocol, body: Json): boolean =>
    protocol === "responses" && isRecord(body) && isText(body["previous_response_id"]);

// Conversations whose requests are stateful, each with every token its requests gave out; few, so few are kept.
const STATEFUL_CONVERSATIONS = 64;

// Tokens back to values in a response, only those its request gave the provider (masker.ts RestoreScope): any other the
// model made up, and it stays as written. Each one is told to `coined`.
const scopedRestore =
    (masker: Masker, given: ReadonlySet<string>, coined: Set<string>): RestoreText =>
    (text, sink) =>
        masker.restoreGiven(text, {
            given: (key) => given.has(key),
            coined: (token) => {
                coined.add(token);
                sink?.(token);
            },
        });

// The log's line for a response in which the model made up tokens; the tokens are only labels and numbers, no value.
const coinedLine = (coined: ReadonlySet<string>, session: GatewaySession): string =>
    `privacy shield: the model wrote ${[...coined].join(", ")}, never given to it${session.conversationId === undefined ? "" : ` in ${session.conversationId}`}; left as written, and a tool call holding one is refused`;

// A stateful conversation's tokens with this request's added, kept for its next request.
const accumulated = (held: BoundedMap<string, Set<string>>, key: string, given: ReadonlySet<string>): Set<string> => {
    const all = new Set([...(held.get(key) ?? []), ...given]);
    held.set(key, all);
    return all;
};

// What restoring a masked request's answer needs: its wire, the masker, the tokens the request gave out, and whose it is.
interface Restoring {
    readonly protocol: GatewayProtocol;
    readonly masker: Masker;
    readonly given: ReadonlySet<string>;
    readonly session: GatewaySession;
}

// The upstream's answer as the runtime gets it: while masking, restored (only the tokens its request gave out), each
// tool call holding a made-up token noted for the harness to refuse, and the made-up tokens logged once it has ended.
const answered = async (upstream: Response, restoring: Restoring | undefined, warn: GatewayRouteDeps["warn"]): Promise<Response> => {
    const init = { status: upstream.status, statusText: upstream.statusText, headers: forwardHeaders(upstream.headers, RESPONSE_REFRAMED) };
    const type = upstream.headers.get("content-type");
    if (restoring === undefined || upstream.body === null) {
        return new Response(upstream.body, init);
    }
    const { protocol, masker, given, session } = restoring;
    const coined = new Set<string>();
    const restore = scopedRestore(masker, given, coined);
    const report = (): void => {
        if (coined.size > 0) {
            warn(coinedLine(coined, session));
        }
    };
    if (isEventStream(type)) {
        const reported = new TransformStream<Uint8Array, Uint8Array>({ flush: report });
        return new Response(upstream.body.pipeThrough(restoreStream(protocol, restore, noteCoinedCall)).pipeThrough(reported), init);
    }
    if (!isJson(type)) {
        return new Response(upstream.body, init);
    }
    const text = await upstream.text();
    let restored: string;
    try {
        restored = JSON.stringify(restoreResponse(protocol, JSON.parse(text), restore, noteCoinedCall));
    } catch {
        // allow(silent-catch): not the JSON it said it was, what came back is still restorable as text, which is all a token is.
        restored = restore(text);
    }
    report();
    return new Response(restored, init);
};

// What follows the session in the path, query included, which is what the upstream is asked for.
const restOf = (c: Context<AppEnv>, token: string): string => {
    const url = new URL(c.req.url);
    const prefix = `${GATEWAY_PATH}/${token}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    return `${path === "" ? "/" : path}${url.search}`;
};

export const createGatewayRoute = ({ shield, warn, fetch: send = fetch }: GatewayRouteDeps) => {
    const statefulGiven = new BoundedMap<string, Set<string>>(STATEFUL_CONVERSATIONS);
    const record = (
        session: GatewaySession,
        verdict: ShieldVerdict,
        fields: { action: PrivacyLedgerAction; protocol: string; tally?: ShieldTally; detail?: string },
    ): void => {
        const tally = fields.tally ?? emptyTally();
        shield.note({ ...session, ...tally, verdict, action: fields.action, protocol: fields.protocol, detail: fields.detail });
    };

    return async (c: Context<AppEnv>): Promise<Response> => {
        const token = c.req.param("session") ?? "";
        const session = await shield.tokens.verify(token);
        if (session === undefined) {
            return c.json({ error: "unknown privacy gateway session" }, 404);
        }
        const rest = restOf(c, token);
        const protocol = protocolOf(rest.split("?")[0] ?? rest);
        let decision: ShieldDecision;
        try {
            decision = await shield.decide({ provider: session.provider, conversationId: session.conversationId, route: "gateway" });
        } catch (error) {
            warn("privacy shield: the policy could not be read, refusing the request", error);
            return refusal(
                protocol,
                `The privacy shield's policy could not be read, so this request was not sent. ${error instanceof Error ? error.message : ""}`.trim(),
            );
        }
        const { policy, verdict } = decision;
        const masking = verdict.kind === "mask";
        const watching = verdict.kind === "watch";
        const contentType = c.req.header("content-type") ?? null;
        const raw = await requestBody(c);
        let body: Uint8Array<ArrayBuffer> | undefined = relayedBody(masking, protocol, contentType, raw);
        let tally: ShieldTally | undefined;
        // The tokens this request gives the provider: what its answer may write back and have restored.
        let given = new Set<string>();

        if ((masking || watching) && raw !== undefined && raw.byteLength > 0) {
            if (protocol === undefined || !isJson(contentType)) {
                // A body on a path no walker knows: masked, it could not be read for what it carries, so it does not go.
                if (masking) {
                    record(session, verdict, { action: "refused", protocol: "other", detail: `unrecognised request ${rest.split("?")[0] ?? ""}` });
                    return refusal(
                        protocol,
                        `The privacy shield does not recognise this request (${c.req.method} ${rest.split("?")[0] ?? ""}), so it was not sent.`,
                    );
                }
            } else {
                tally = emptyTally();
                try {
                    const parsed = toJson(JSON.parse(new TextDecoder().decode(raw)));
                    const masker = await shield.masker(policy);
                    const walker = masking
                        ? maskingShield({
                              masker,
                              readers: shield.readers,
                              readings: shield.readings,
                              images: policy.images,
                              tally,
                              given,
                              archive: shield.images,
                          })
                        : watchingShield({ masker, tally, images: policy.images });
                    const shielded = await shieldRequest(protocol, parsed, walker);
                    given = isStateful(protocol, parsed) ? accumulated(statefulGiven, session.conversationId ?? token, given) : given;
                    // The tokens the provider is about to read must be on disk before it reads them.
                    await shield.vault.commit();
                    if (masking) {
                        body = maskedBody(protocol, shielded);
                    }
                } catch (error) {
                    warn("privacy shield: a request could not be masked", error);
                    if (masking) {
                        record(session, verdict, {
                            action: "refused",
                            protocol,
                            tally,
                            detail: error instanceof Error ? error.message : "masking failed",
                        });
                        return refusal(
                            protocol,
                            `The privacy shield could not mask this request, so it was not sent. ${error instanceof Error ? error.message : ""}`.trim(),
                        );
                    }
                }
            }
        }

        // Off, a session minted while it was on is a plain relay and leaves no line: the log is the shield's record.
        if (protocol !== undefined && raw !== undefined && policy.mode !== "off") {
            record(session, verdict, {
                action: masking ? "masked" : watching ? "watched" : "passed",
                protocol,
                ...(tally !== undefined ? { tally } : {}),
            });
        }

        const upstreamUrl = `${session.upstream.replace(/\/$/u, "")}${rest}`;
        const headers = forwardHeaders(c.req.raw.headers, REQUEST_REFRAMED);
        headers.set("accept-encoding", "identity");
        let upstream: Response;
        try {
            upstream = await send(upstreamUrl, {
                method: c.req.method,
                headers,
                ...(body !== undefined ? { body } : {}),
                signal: c.req.raw.signal,
            });
        } catch (error) {
            if (c.req.raw.signal.aborted) {
                return new Response(null, { status: 499 });
            }
            warn(`privacy shield: the upstream ${new URL(upstreamUrl).host} could not be reached`, error);
            return c.json(
                {
                    type: "error",
                    error: {
                        type: "api_error",
                        message: `The model provider could not be reached (${error instanceof Error ? error.message : "network error"}).`,
                    },
                },
                502,
            );
        }
        // Tokens can come back even from a request that carried none: the model repeats what earlier ones carried.
        const restoring = masking && protocol !== undefined ? { protocol, masker: await shield.masker(policy), given, session } : undefined;
        return answered(upstream, restoring, warn);
    };
};
