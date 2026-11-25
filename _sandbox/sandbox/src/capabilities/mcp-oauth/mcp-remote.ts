import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { MountCall } from "../../agent/tools/turn-mounts.routes.js";
import { readBoundedBytes } from "../../http/bounded-body.js";
import { forwardHeaders, REQUEST_REFRAMED, RESPONSE_REFRAMED } from "../../http/forward-headers.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import { createOpenCalls, credentialPrint, type OpenCall, type OpenCalls } from "../credentials/open-calls.js";
import type { BearerOf } from "./mcp-renewal.js";
import { mcpSessionOf } from "./mcp-session.js";
import { isList, isRecord, isText, type Json, mapAll, parseJson, patch } from "../../privacy/gateway/protocols/walk.js";
import { resolveCallSecrets, type SecretAccess } from "../../secrets/secret-access.js";
import { hasSecretReferences } from "../../secrets/secret-registry.js";

// An MCP server the owner connected (an mcp-kind card), reached by the agent through the turn's MCP door (`/mcp/<name>`,
// turn-mounts.routes.ts) rather than at its own address: the agent holds only the turn's bearer, and every request is
// forwarded to the server with the card's credential attached here: a pasted token as it is, a sign-in's access token
// renewed when it is about to lapse. A token the server refuses anyway is renewed once and the request sent again, so a
// turn longer than an access token's life never sees it lapse. The door carries a bounded number of calls at once
// (open-calls.ts: a GET's event stream in its own pool), holds a request body to MCP_BODY_MAX, and cuts an open call or
// stream once its connection is removed, signed in again as someone else or pasted over, or the conversation's reach no
// longer covers it.
//
// It is also where a `{{secret:…}}` reference in a tool call's arguments becomes its value, the one place every
// runtime's call to the server passes (resolveCallSecrets): gated like a request to the server's host, so a secret whose
// host guard lists that host goes unasked, one whose guard does not asks a person, and one whose guard is off goes, as
// it would if typed into a page there. Every message the server answers with is masked back on its way to the agent,
// JSON or event stream alike, so a value the server echoes reaches no runtime's model. 2026-11-25 (issue #57): chosen
// over resolving references in every MCP tool's arguments, since only a server that is itself the destination gives
// the host guard something to check; the daemon's own servers (browsers, devices, subagents) pass a value on to places
// their arguments name, and `type_secret` is the way into those.

export interface RemoteDeps {
    readonly capabilities: Pick<CapabilitiesStore, "get">;
    readonly bearer: BearerOf;
    readonly fetch?: typeof fetch;
    // The secret seam a call's references resolve through, bound to the conversation the turn's bearer names and to
    // the call's own signal; absent forwards a reference as the text it is.
    readonly secrets?: (conversationId: string | undefined, signal: AbortSignal) => SecretAccess;
    // One message the server sent, every stored secret's value in it masked to its reference; absent forwards answers
    // as they came.
    readonly mask?: (message: Json) => Promise<Json>;
    // Whether the conversation may still spend this capability (credential-reach.ts); absent, nobody is limited.
    readonly reaches?: (conversationId: string | undefined, capability: string) => Promise<boolean>;
    readonly openCalls?: OpenCalls;
}

// A JSON-RPC message or batch, held whole since a refused one is sent again; far past any real one.
export const MCP_BODY_MAX = 8 * 1024 * 1024;

// Which connection a call speaks as: the server's address and who signed in, not the access token itself, which a
// renewal replaces without the credential changing hands.
const printOf = (config: { readonly url: string; readonly token?: string | undefined }): string => {
    const session = mcpSessionOf(config.token);
    return session === undefined
        ? credentialPrint([config.url, config.token?.trim()])
        : credentialPrint([config.url, session.issuer, session.clientId, session.account, session.resource]);
};

// Why an open call may no longer run, or undefined while it may.
const staleness =
    (deps: RemoteDeps) =>
    async (call: OpenCall): Promise<string | undefined> => {
        const card = await deps.capabilities.get(call.subject);
        if (card?.kind !== "mcp") {
            return "this connection was removed";
        }
        if (printOf(card.config) !== call.print) {
            return "this connection was signed in again or given another token";
        }
        if (deps.reaches !== undefined && !(await deps.reaches(call.conversationId, call.subject))) {
            return "this conversation may no longer use this connection";
        }
        return undefined;
    };

// What the agent's client sent that is the door's, not the server's: the turn's bearer and anything describing the hop.
const DROPPED = [...REQUEST_REFRAMED, "authorization", "cookie"];

const refusal = (c: Context<AppEnv>, name: string, said: string, status: 401 | 403 | 404 | 413 | 429): Response =>
    c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `${name}: ${said}` } }, status);

type RemoteTarget = { readonly kind: "remote"; readonly capability: string };

export const createMcpRemoteEndpoint = (deps: RemoteDeps) => {
    const openCalls = deps.openCalls ?? createOpenCalls();
    const stale = staleness(deps);
    openCalls.watch(stale);
    return async (target: RemoteTarget, c: Context<AppEnv>, call: MountCall): Promise<Response> => {
        const card = await deps.capabilities.get(target.capability);
        if (card?.kind !== "mcp") {
            return refusal(c, call.name, "this connection was removed", 404);
        }
        const opening: OpenCall = {
            subject: target.capability,
            conversationId: call.conversationId,
            pool: c.req.method === "GET" ? "stream" : "call",
            print: printOf(card.config),
        };
        const admitted = openCalls.admit(opening, call.signal);
        if (admitted === undefined) {
            const what = opening.pool === "stream" ? "event streams" : "calls";
            return refusal(c, call.name, `too many ${what} to this sandbox's MCP servers are open at once; wait for one to finish`, 429);
        }
        try {
            const answer = await forward(deps, target, card.config.url, c, { ...call, signal: admitted.signal }, stale, opening);
            return admitted.hold(answer);
        } catch (error) {
            admitted.release();
            throw error;
        }
    };
};

const forward = async (
    deps: RemoteDeps,
    target: RemoteTarget,
    url: string,
    c: Context<AppEnv>,
    call: MountCall,
    stale: (call: OpenCall) => Promise<string | undefined>,
    opening: OpenCall,
): Promise<Response> => {
    const out = await stale(opening);
    if (out !== undefined) {
        return refusal(c, call.name, out, 403);
    }
    const first = await deps.bearer(target.capability);
    if ("signIn" in first) {
        return refusal(c, call.name, first.signIn, 401);
    }
    // Held in memory, since a refused request is sent again; a JSON-RPC message is small, and one past the cap is
    // refused before more of it is read.
    let body: Uint8Array<ArrayBuffer> | null = null;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        const read = await readBoundedBytes(c.req.raw, MCP_BODY_MAX);
        if (read.kind !== "ok") {
            return refusal(c, call.name, `a request body is at most ${String(MCP_BODY_MAX / 1024 / 1024)} MiB`, 413);
        }
        body = new Uint8Array(read.value);
    }
    if (body !== null && deps.secrets !== undefined) {
        const prepared = await resolvedBody(deps.secrets, target, url, body, call);
        if ("refused" in prepared) {
            return c.json(prepared.refused);
        }
        body = prepared.body;
    }
    const send = (bearer: string | undefined): Promise<Response> => {
        const headers = forwardHeaders(c.req.raw.headers, DROPPED);
        if (bearer !== undefined) {
            headers.set("authorization", `Bearer ${bearer}`);
        }
        // Redirects are the client's to follow: following one here would carry the bearer to wherever it points.
        return (deps.fetch ?? fetch)(url, { method: c.req.method, headers, body, redirect: "manual", signal: call.signal });
    };
    let upstream = await send(first.bearer);
    if (upstream.status === 401) {
        const renewed = await deps.bearer(target.capability, { force: true });
        if ("signIn" in renewed) {
            await upstream.body?.cancel();
            return refusal(c, call.name, renewed.signIn, 401);
        }
        if (renewed.bearer !== first.bearer) {
            await upstream.body?.cancel();
            upstream = await send(renewed.bearer);
        }
    }
    const headers = forwardHeaders(upstream.headers, RESPONSE_REFRAMED);
    return new Response(deps.mask === undefined ? upstream.body : await maskedBody(upstream, deps.mask), { status: upstream.status, headers });
};

// One JSON-RPC message, read off a body only through the guards that check its shape.
const toolCallOf = (message: Json): { readonly id: Json; readonly tool: string; readonly args: Json } | undefined => {
    if (!isRecord(message) || message["method"] !== "tools/call") {
        return undefined;
    }
    const params = message["params"];
    if (!isRecord(params) || !isText(params["name"])) {
        return undefined;
    }
    const args = params["arguments"];
    return args === undefined ? undefined : { id: message["id"] ?? null, tool: params["name"], args };
};

// A refused call answered as the tool's own error, the way a server says a call failed, so the model reads why.
const refusedCall = (id: Json, why: string): Json => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: why }], isError: true } });

const NOT_SENT = "Not sent: another call in the same batch was refused, so none of them went. Make the calls one at a time.";

// The body to forward, every tools/call's references resolved, or the answer to give instead when any was refused: a
// batch goes whole or not at all. A body that is not JSON, or carries no call with a reference, goes as it came.
const resolvedBody = async (
    secretsOf: NonNullable<RemoteDeps["secrets"]>,
    target: RemoteTarget,
    url: string,
    body: Uint8Array<ArrayBuffer>,
    call: MountCall,
): Promise<{ readonly body: Uint8Array<ArrayBuffer> } | { readonly refused: Json }> => {
    const text = new TextDecoder().decode(body);
    if (!hasSecretReferences(text)) {
        return { body };
    }
    const parsed = parseJson(text);
    if (parsed === undefined) {
        return { body };
    }
    const messages = isList(parsed) ? parsed : [parsed];
    const secrets = secretsOf(call.conversationId, call.signal);
    // A card may wait on a person here: the turn is waiting on the daemon, not on its vendor (turn-mounts.routes.ts held).
    const release = call.hold?.();
    const outcomes: { readonly message: Json; readonly refused?: string }[] = [];
    try {
        for (const message of messages) {
            const found = toolCallOf(message);
            if (found === undefined) {
                outcomes.push({ message });
                continue;
            }
            const tool = `mcp__${call.name}__${found.tool}`;
            const resolved = await resolveCallSecrets(found.args, secrets, { kind: "mcp", server: target.capability, url, tool });
            if ("refusal" in resolved) {
                outcomes.push({ message, refused: resolved.refusal });
                continue;
            }
            const params = isRecord(message) ? message["params"] : undefined;
            outcomes.push({ message: isRecord(message) && isRecord(params) ? patch(message, "params", patch(params, "arguments", resolved.arguments)) : message });
        }
    } finally {
        release?.();
    }
    if (outcomes.some((outcome) => outcome.refused !== undefined)) {
        const answers = outcomes.flatMap(({ message, refused }): Json[] => {
            const id = isRecord(message) ? message["id"] : undefined;
            return id === undefined ? [] : [refusedCall(id, refused ?? NOT_SENT)];
        });
        return { refused: isList(parsed) ? answers : (answers[0] ?? null) };
    }
    const forwarded = outcomes.map((outcome) => outcome.message);
    return { body: new TextEncoder().encode(JSON.stringify(isList(parsed) ? forwarded : forwarded[0])) };
};

// What the server answered, every message in it masked: a JSON body whole, an event stream event by event as it comes,
// so a stream still streams. Anything else (an empty 202, an error page) carries no message and goes as it came.
const maskedBody = async (upstream: Response, mask: (message: Json) => Promise<Json>): Promise<BodyInit | null> => {
    const type = upstream.headers.get("content-type") ?? "";
    if (upstream.body === null) {
        return null;
    }
    if (type.includes("text/event-stream")) {
        return upstream.body.pipeThrough(maskedEvents(mask));
    }
    if (!type.includes("json")) {
        return upstream.body;
    }
    const text = await upstream.text();
    const parsed = parseJson(text);
    if (parsed === undefined) {
        return text;
    }
    const masked = isList(parsed) ? await mapAll(parsed, mask) : await mask(parsed);
    return JSON.stringify(masked) === JSON.stringify(parsed) ? text : JSON.stringify(masked);
};

// Where one event of a stream ends: a blank line, in any of the three line endings the format allows.
const EVENT_END = /\r\n\r\n|\n\n|\r\r/;
const LINE_END = /\r\n|\n|\r/;

// One event with its data masked: its other fields kept in order, its data lines (one message, split however the server
// split it) replaced by one. An event with no data, or data that is not JSON, goes as it came.
const maskedEvent = async (event: string, mask: (message: Json) => Promise<Json>): Promise<string> => {
    const lines = event.split(LINE_END);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
    const parsed = data.length === 0 ? undefined : parseJson(data.join("\n"));
    if (parsed === undefined) {
        return event;
    }
    const masked = await mask(parsed);
    if (JSON.stringify(masked) === JSON.stringify(parsed)) {
        return event;
    }
    return [...lines.filter((line) => !line.startsWith("data:")), `data: ${JSON.stringify(masked)}`].join("\n");
};

const maskedEvents = (mask: (message: Json) => Promise<Json>): TransformStream<Uint8Array, Uint8Array> => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let held = "";
    return new TransformStream<Uint8Array, Uint8Array>({
        transform: async (chunk, controller) => {
            held += decoder.decode(chunk, { stream: true });
            for (let end = EVENT_END.exec(held); end !== null; end = EVENT_END.exec(held)) {
                const event = held.slice(0, end.index);
                held = held.slice(end.index + end[0].length);
                controller.enqueue(encoder.encode(`${await maskedEvent(event, mask)}${end[0]}`));
            }
        },
        flush: async (controller) => {
            held += decoder.decode();
            if (held !== "") {
                controller.enqueue(encoder.encode(await maskedEvent(held, mask)));
            }
        },
    });
};
