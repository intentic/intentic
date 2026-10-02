import type { PersonalDataClass, PrivacyLedgerAction, PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { GATEWAY_PATH, type PrivacyShield } from "../privacy-shield.js";
import { type GatewayProtocol, protocolOf, restoreResponse, restoreStream, shieldRequest } from "./protocols/index.js";
import { emptyTally, maskingShield, watchingShield } from "./request-shield.js";
import type { GatewaySession } from "./session-token.js";
import type { ShieldTally } from "./shield-types.js";

// `ALL /privacy/gateway/<session>/*`: where every shielded runtime sends its model requests. The session names the
// provider and the upstream the runtime would otherwise have called; the request goes there with its own headers
// untouched (the runtime's credential travels as it would have), and only its body changes. Masking happens only for an
// untrusted provider while the shield is on; watching reads and records but sends the request as it came; anything else
// is a plain relay. A request that cannot be masked is refused, never sent as it came.

export interface GatewayRouteDeps {
    readonly shield: PrivacyShield;
    readonly warn: (message: string, error?: unknown) => void;
    readonly fetch?: typeof fetch;
    readonly now?: () => Date;
}

// Hop-by-hop and framing headers, which describe this connection rather than the request; `accept-encoding` too, so the
// answer arrives as text the stream transform can read.
const REQUEST_DROPPED = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "keep-alive", "upgrade"]);
const RESPONSE_DROPPED = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

const forwardHeaders = (from: Headers, dropped: ReadonlySet<string>): Headers => {
    const headers = new Headers();
    for (const [name, value] of from) {
        if (!dropped.has(name.toLowerCase())) {
            headers.set(name, value);
        }
    }
    return headers;
};

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
const isEventStream = (type: string | null): boolean => type !== null && /^text\/event-stream\b/iu.test(type);

// What follows the session in the path, query included, which is what the upstream is asked for.
const restOf = (c: Context<AppEnv>, token: string): string => {
    const url = new URL(c.req.url);
    const prefix = `${GATEWAY_PATH}/${token}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    return `${path === "" ? "/" : path}${url.search}`;
};

export const createGatewayRoute = ({ shield, warn, fetch: send = fetch, now = () => new Date() }: GatewayRouteDeps) => {
    const record = (
        session: GatewaySession,
        fields: { action: PrivacyLedgerAction; trusted: boolean; protocol: string; tally?: ShieldTally; detail?: string },
    ): void => {
        const tally = fields.tally ?? emptyTally();
        void shield.ledger
            .record({
                at: now().toISOString(),
                ...(session.conversationId !== undefined ? { conversationId: session.conversationId } : {}),
                provider: session.provider,
                trusted: fields.trusted,
                action: fields.action,
                counts: tally.counts as Partial<Record<PersonalDataClass, number>>,
                images: tally.images,
                documents: tally.documents,
                protocol: fields.protocol,
                ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
            })
            .catch((error: unknown) => warn("privacy shield: the log could not be written", error));
    };

    return async (c: Context<AppEnv>): Promise<Response> => {
        const token = c.req.param("session") ?? "";
        const session = await shield.tokens.verify(token);
        if (session === undefined) {
            return c.json({ error: "unknown privacy gateway session" }, 404);
        }
        const rest = restOf(c, token);
        const protocol = protocolOf(rest.split("?")[0] ?? rest);
        let policy: PrivacyShieldPolicy;
        let trusted: boolean;
        try {
            policy = await shield.policy();
            trusted = await shield.trusted(policy, session.provider, session.conversationId);
        } catch (error) {
            warn("privacy shield: the policy could not be read, refusing the request", error);
            return refusal(
                protocol,
                `The privacy shield's policy could not be read, so this request was not sent. ${error instanceof Error ? error.message : ""}`.trim(),
            );
        }
        const masking = policy.mode === "on" && !trusted;
        const watching = policy.mode === "watch" && !trusted;
        const raw = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : new Uint8Array(await c.req.arrayBuffer());
        const contentType = c.req.header("content-type") ?? null;
        let body: Uint8Array<ArrayBuffer> | undefined = raw;
        let tally: ShieldTally | undefined;

        if ((masking || watching) && raw !== undefined && raw.byteLength > 0) {
            if (protocol === undefined || !isJson(contentType)) {
                // A body on a path no walker knows: masked, it could not be read for what it carries, so it does not go.
                if (masking) {
                    record(session, { action: "refused", trusted, protocol: "other", detail: `unrecognised request ${rest.split("?")[0] ?? ""}` });
                    return refusal(
                        protocol,
                        `The privacy shield does not recognise this request (${c.req.method} ${rest.split("?")[0] ?? ""}), so it was not sent.`,
                    );
                }
            } else {
                tally = emptyTally();
                try {
                    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
                    const masker = await shield.masker(policy);
                    const walker = masking
                        ? maskingShield({ masker, readers: shield.readers, readings: shield.readings, images: policy.images, tally })
                        : watchingShield({ masker, tally, images: policy.images });
                    const shielded = await shieldRequest(protocol, parsed, walker);
                    // The tokens the provider is about to read must be on disk before it reads them.
                    await shield.vault.commit();
                    if (masking) {
                        body = new TextEncoder().encode(JSON.stringify(shielded));
                    }
                } catch (error) {
                    warn("privacy shield: a request could not be masked", error);
                    if (masking) {
                        record(session, {
                            action: "refused",
                            trusted,
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
            record(session, {
                action: masking ? "masked" : watching ? "watched" : "passed",
                trusted,
                protocol,
                ...(tally !== undefined ? { tally } : {}),
            });
        }

        const upstreamUrl = `${session.upstream.replace(/\/$/u, "")}${rest}`;
        const headers = forwardHeaders(c.req.raw.headers, REQUEST_DROPPED);
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
        const responseHeaders = forwardHeaders(upstream.headers, RESPONSE_DROPPED);
        const type = upstream.headers.get("content-type");
        // Tokens can come back even from a request that carried none: the model repeats what earlier ones carried.
        if (!masking || protocol === undefined || upstream.body === null) {
            return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
        }
        const masker = await shield.masker(policy);
        if (isEventStream(type)) {
            return new Response(upstream.body.pipeThrough(restoreStream(protocol, masker.restore)), {
                status: upstream.status,
                statusText: upstream.statusText,
                headers: responseHeaders,
            });
        }
        if (isJson(type)) {
            const text = await upstream.text();
            try {
                const restored = restoreResponse(protocol, JSON.parse(text), masker.restore);
                return new Response(JSON.stringify(restored), { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
            } catch {
                // Not the JSON it said it was: what came back is still restorable as text, which is all a token is.
                return new Response(masker.restore(text), { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
            }
        }
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    };
};
