import type { PersonalDataClass, PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { PrivacyShield } from "../privacy-shield.js";
import { type Json, isList, isRecord, isText, restoreStrings, toJson } from "./protocols/walk.js";
import { type SseEvent, sseAsyncTransform } from "./protocols/sse.js";
import { emptyTally, maskingShield, watchingShield } from "./request-shield.js";
import type { RequestShield, RestoreText, ShieldTally } from "./shield-types.js";

// `ALL /privacy/mcp/<session>`: where a turn on a hooked runtime (Cursor, agent-runtimes.ts `privacy: "hooks"`) calls each
// of its MCP servers while the shield reads that turn. The runtime runs the MCP client itself and sends what a server
// answers to its own provider, past the gateway, so this is the one place those answers pass the daemon. The session
// names the provider, the conversation and the server's own address; the request goes there with its own headers (its
// bearer travels as it would have), tokens in what the model sent read back to their values, and what the server
// answers is masked before the runtime, and so the model, reads it. Watching reads and logs and changes nothing; off or
// trusted, a plain relay.

export interface McpRouteDeps {
    readonly shield: PrivacyShield;
    readonly warn: (message: string, error?: unknown) => void;
    readonly fetch?: typeof fetch;
}

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

const isJson = (type: string | null): boolean => type !== null && /^application\/([\w.+-]*\+)?json\b/iu.test(type);
const isEventStream = (type: string | null): boolean => type !== null && /^text\/event-stream\b/iu.test(type);

// Answers that describe the server rather than carry what it read: its own name and version, and the lists of what it
// offers. Left as the server wrote them, so a tool's name and schema still match the call the model makes.
const DESCRIBING = new Set(["initialize", "ping", "tools/list", "resources/list", "resources/templates/list", "prompts/list", "logging/setLevel"]);

// Strings that are structure in an MCP message, never content: a content block's kind and a binary's media type.
const STRUCTURAL = new Set(["type", "mimeType", "jsonrpc"]);

const WITHHELD_BINARY =
    "[A binary result was withheld by the privacy shield: this model provider is not trusted with personal data, and it could not be read on this machine to check it.]";

// Every string of a value masked, every picture through the shield's image pass, and every other binary (audio, a blob
// that is no picture) replaced by a note, since nothing here can read it to check it.
const shieldValue = async (value: Json, shield: RequestShield, masking: boolean, key?: string): Promise<Json> => {
    if (isText(value)) {
        return key !== undefined && STRUCTURAL.has(key) ? value : value === "" ? value : shield.mask(value);
    }
    if (isList(value)) {
        return Promise.all(value.map(async (item) => shieldValue(item, shield, masking)));
    }
    if (!isRecord(value)) {
        return value;
    }
    const kind = value["type"];
    const mimeType = isText(value["mimeType"]) ? value["mimeType"] : undefined;
    // A content block's picture: { type: "image", data, mimeType }.
    if (kind === "image" && isText(value["data"]) && mimeType !== undefined) {
        const verdict = await shield.image({ mediaType: mimeType, data: value["data"] });
        if (!masking || verdict === "keep") {
            return value;
        }
        return "text" in verdict ? { type: "text", text: verdict.text } : { ...value, data: verdict.image.data, mimeType: verdict.image.mediaType };
    }
    // Audio, and a resource's blob that is no picture: nothing on this machine reads either.
    if (masking && (kind === "audio" || (isText(value["blob"]) && !(mimeType?.startsWith("image/") ?? false)))) {
        return { type: "text", text: WITHHELD_BINARY };
    }
    if (isText(value["blob"]) && mimeType !== undefined) {
        const verdict = await shield.image({ mediaType: mimeType, data: value["blob"] });
        if (!masking || verdict === "keep") {
            return value;
        }
        return "text" in verdict ? { type: "text", text: verdict.text } : { ...value, blob: verdict.image.data, mimeType: verdict.image.mediaType };
    }
    const entries = await Promise.all(Object.entries(value).map(async ([field, item]) => [field, await shieldValue(item, shield, masking, field)] as const));
    return Object.fromEntries(entries);
};

// One JSON-RPC message from the server, as the model may read it: a result masked unless it only describes the server;
// a request or notification the server sends (a sampling request, a log line, progress) masked in its params; an error's
// words masked. `methods` names each request this POST carried by its id, which is how a result is known for what it is.
const shieldMessage = async (message: Json, methods: ReadonlyMap<string, string>, shield: RequestShield, masking: boolean): Promise<Json> => {
    if (isList(message)) {
        return Promise.all(message.map(async (each) => shieldMessage(each, methods, shield, masking)));
    }
    if (!isRecord(message)) {
        return message;
    }
    let out = message;
    const id = message["id"];
    const answered = typeof id === "string" || typeof id === "number" ? methods.get(String(id)) : undefined;
    if ("result" in message && (answered === undefined || !DESCRIBING.has(answered))) {
        out = { ...out, result: await shieldValue(message["result"] ?? null, shield, masking) };
    }
    if (isText(message["method"]) && "params" in message) {
        out = { ...out, params: await shieldValue(message["params"] ?? null, shield, masking) };
    }
    const error = message["error"];
    if (isRecord(error) && isText(error["message"])) {
        out = { ...out, error: { ...error, message: await shield.mask(error["message"]) } };
    }
    return out;
};

// The requests a client message carries, by id, so their answers can be told apart.
const methodsOf = (message: Json, into = new Map<string, string>()): Map<string, string> => {
    if (isList(message)) {
        for (const each of message) {
            methodsOf(each, into);
        }
    } else if (isRecord(message) && isText(message["method"]) && (typeof message["id"] === "string" || typeof message["id"] === "number")) {
        into.set(String(message["id"]), message["method"]);
    }
    return into;
};

// Tokens in what the model sent (a tool call's arguments, a resource's address) back to the values they stand for, so
// the server acts on the real ones, as a runtime behind the gateway would have sent them.
const restoreMessage = (message: Json, restore: RestoreText): Json => {
    if (isList(message)) {
        return message.map((each) => restoreMessage(each, restore));
    }
    return isRecord(message) && "params" in message ? { ...message, params: restoreStrings(message["params"] ?? null, restore) } : message;
};

// A JSON-RPC error the client shows for a request this proxy would not send or could not read the answer of.
const rpcError = (status: number, message: string): Response =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32_000, message } }), { status, headers: { "content-type": "application/json" } });

export const createMcpRoute = ({ shield, warn, fetch: send = fetch }: McpRouteDeps) => {
    const record = (session: { provider: string; conversationId?: string | undefined }, masking: boolean, tally: ShieldTally): void => {
        if (Object.keys(tally.counts).length === 0 && tally.images === 0) {
            return;
        }
        void shield.ledger
            .record({
                at: new Date().toISOString(),
                ...(session.conversationId !== undefined ? { conversationId: session.conversationId } : {}),
                provider: session.provider,
                trusted: false,
                action: masking ? "masked" : "watched",
                counts: tally.counts as Partial<Record<PersonalDataClass, number>>,
                images: tally.images,
                documents: tally.documents,
                protocol: "hooks:mcp",
                ...(tally.replacements.length > 0 ? { replacements: tally.replacements } : {}),
            })
            .catch((error: unknown) => warn("privacy shield: the log could not be written", error));
    };

    return async (c: Context<AppEnv>): Promise<Response> => {
        const session = await shield.tokens.verify(c.req.param("session") ?? "");
        if (session === undefined) {
            return c.json({ error: "unknown privacy MCP session" }, 404);
        }
        let policy: PrivacyShieldPolicy;
        let trusted: boolean;
        try {
            policy = await shield.policy();
            trusted = await shield.trusted(policy, session.provider, session.conversationId);
        } catch (error) {
            warn("privacy shield: the policy could not be read, refusing the MCP request", error);
            return rpcError(502, "The privacy shield's policy could not be read, so this tool call was not sent.");
        }
        const masking = policy.mode === "on" && !trusted;
        const watching = policy.mode === "watch" && !trusted;
        const reading = masking || watching;
        const masker = reading ? await shield.masker(policy) : undefined;

        let body: string | undefined;
        let methods = new Map<string, string>();
        if (c.req.method !== "GET" && c.req.method !== "HEAD") {
            body = await c.req.text();
            if (reading && body !== "" && isJson(c.req.header("content-type") ?? null)) {
                try {
                    const parsed = toJson(JSON.parse(body));
                    methods = methodsOf(parsed);
                    if (masking && masker !== undefined) {
                        body = JSON.stringify(restoreMessage(parsed, masker.restore));
                    }
                } catch {
                    // allow(silent-catch): a body that is not the JSON it says it is goes as it came; the server answers it.
                }
            }
        }

        const query = new URL(c.req.url).search;
        const upstreamUrl = `${session.upstream}${query}`;
        const headers = forwardHeaders(c.req.raw.headers, REQUEST_DROPPED);
        headers.set("accept-encoding", "identity");
        let upstream: Response;
        try {
            upstream = await send(upstreamUrl, { method: c.req.method, headers, ...(body !== undefined ? { body } : {}), signal: c.req.raw.signal });
        } catch (error) {
            if (c.req.raw.signal.aborted) {
                return new Response(null, { status: 499 });
            }
            warn(`privacy shield: the MCP server ${new URL(session.upstream).host} could not be reached`, error);
            return rpcError(502, `The MCP server could not be reached (${error instanceof Error ? error.message : "network error"}).`);
        }
        const responseHeaders = forwardHeaders(upstream.headers, RESPONSE_DROPPED);
        const type = upstream.headers.get("content-type");
        const status = { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders };
        if (!reading || masker === undefined || upstream.body === null) {
            return new Response(upstream.body, status);
        }
        const tally = emptyTally();
        const walker = masking
            ? maskingShield({ masker, readers: shield.readers, readings: shield.readings, images: policy.images, tally })
            : watchingShield({ masker, tally, images: policy.images });

        if (isEventStream(type)) {
            const change = async (event: SseEvent): Promise<SseEvent> => {
                const parsed = event.data === undefined ? undefined : (() => {
                    try {
                        return toJson(JSON.parse(event.data));
                    } catch {
                        // allow(silent-catch): an event whose data is not JSON is masked below as plain text.
                        return undefined;
                    }
                })();
                const data =
                    parsed === undefined
                        ? await walker.mask(event.data ?? "")
                        : JSON.stringify(await shieldMessage(parsed, methods, walker, masking));
                await shield.vault.commit();
                record(session, masking, { ...tally, counts: { ...tally.counts }, replacements: [...tally.replacements] });
                // Each event logged for what it alone added, so a stream that runs for a turn does not repeat itself.
                for (const kind of Object.keys(tally.counts)) {
                    delete (tally.counts as Record<string, number>)[kind];
                }
                tally.replacements.length = 0;
                tally.images = 0;
                return masking ? { event: event.event, data, raw: undefined } : event;
            };
            return new Response(upstream.body.pipeThrough(sseAsyncTransform(change)), status);
        }
        const text = await upstream.text();
        let answer = text;
        try {
            if (isJson(type)) {
                answer = JSON.stringify(await shieldMessage(toJson(JSON.parse(text)), methods, walker, masking));
            } else if (text !== "") {
                answer = await walker.mask(text);
            }
            await shield.vault.commit();
        } catch (error) {
            warn("privacy shield: an MCP answer could not be masked", error);
            if (masking) {
                return rpcError(502, `The privacy shield could not mask this tool's answer, so it was withheld. ${error instanceof Error ? error.message : ""}`.trim());
            }
        }
        record(session, masking, tally);
        return new Response(masking ? answer : text, status);
    };
};
