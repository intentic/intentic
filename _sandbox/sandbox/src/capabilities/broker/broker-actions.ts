import type { BrokerAction } from "@intentic/extension-manifest";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";
import type { AdmissionRule } from "@intentic/sandbox-contract/schemas/command-admission";
import { ERROR_TAIL, type CallOutcome, type OutboundCall, refusalIn } from "../../activity/outbound.js";
import { actionRefusal } from "../../guard/outbound-guard.js";
import { opt } from "../../opt.js";
import { pathMatches } from "./broker-rules.js";

// The outward action one request through the credential gateway performs, read off the card's own declaration
// (`broker.actions`): the gateway holds it to the owner's action rules before the credential is attached, and records
// it in Activity once it is answered, in the row shape the command sniffer writes (activity/outbound.ts). The gateway
// sees the real method, path and body, whatever variable or quoting the command that sent it used, so this is where a
// brokered send is recognised. A card that declares no actions is neither recorded nor held here.

// A request no declared action covers, on a card that declares some: recorded, and held to a `<card id>.*` rule.
const UNDECLARED_ACTION = "api.call";

// How much of a request's body is read for its row, and of an answer for its outcome. A body past this is forwarded
// whole, and its row goes without what lay beyond.
const REQUEST_HEAD_BYTES = 256 * 1024;
const ANSWER_HEAD_BYTES = 64 * 1024;

// What the gateway hands its caller to record: the call, whose conversation it was, and how it went.
export interface GatewayOutbound extends Partial<CallOutcome> {
    readonly call: OutboundCall;
    readonly conversationId: string | undefined;
}

export interface OutwardDeps {
    // The owner's action rules (SandboxSettings.actionRules), read per request so a rule changed mid-turn binds at once.
    readonly actionRules?: () => Promise<Readonly<Record<string, AdmissionRule>>>;
    readonly outbound?: (record: GatewayOutbound) => void;
    // Where a row that could not be put together is said, since the request it describes went on without it.
    readonly warn?: (message: string, error: Error) => void;
}

export interface OutwardRequestInput {
    // The card id its actions are declared under: the action key's prefix and the row's provider.
    readonly provider: string;
    readonly actions: readonly BrokerAction[] | undefined;
    readonly request: Request;
    readonly method: string;
    // Below the route's upstream, without the query: what the declarations' paths are written against.
    readonly path: string;
    readonly query: URLSearchParams;
    readonly conversationId: string | undefined;
    // Whether the gateway reads the body itself (a route whose credential rides a form): then this one does not.
    readonly bodyTaken: boolean;
}

export interface OutwardRequest {
    // The owner's rules' refusal (a deny's reason, a hold's redirect to the approvals queue), else undefined.
    readonly refusal: string | undefined;
    // The body to forward: the request's own, or one branch of it while the other is read for the row.
    readonly body: ReadableStream<Uint8Array> | null;
    // Records the row once the answer is known, and hands the answer on (its body teed when its outcome is read).
    readonly settle: (response: Response) => Response;
}

interface BodyHead {
    readonly text: string;
    // Whether the whole body was read, rather than its first REQUEST_HEAD_BYTES.
    readonly complete: boolean;
}

const covers = (action: BrokerAction, method: string, path: string): boolean =>
    (action.methods === undefined || action.methods.includes(method)) && (action.paths === undefined || action.paths.some((pattern) => pathMatches(pattern, path)));

// The first declared action covering a request, undefined when none does.
const requestAction = (actions: readonly BrokerAction[], method: string, path: string): BrokerAction | undefined =>
    actions.find((action) => covers(action, method.toUpperCase(), path));

const segmentAfter = (path: string, segment: string): string | undefined => {
    const segments = path.split("/").filter((each) => each !== "");
    const at = segments.indexOf(segment);
    return at === -1 ? undefined : segments[at + 1];
};

// Up to `limit` bytes of a stream, then let go of it: what is left reaches the other branch of a tee, not this one.
const headOf = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<BodyHead> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let complete = false;
    try {
        while (size <= limit) {
            const { done, value } = await reader.read();
            if (done) {
                complete = true;
                break;
            }
            chunks.push(value);
            size += value.byteLength;
        }
        // allow(silent-catch): a body the client stopped sending is recorded as far as it got; the row is all it feeds
    } catch {
        complete = false;
    } finally {
        if (!complete) {
            // allow(silent-catch): letting go of a branch that already ended or failed has nothing left to report
            void reader.cancel().catch(() => undefined);
        }
    }
    const bytes = Buffer.concat(chunks).subarray(0, limit);
    return { text: new TextDecoder().decode(bytes), complete: complete && size <= limit };
};

// A JSON body's top-level field as text: a string, number or boolean, never a nested value.
const jsonField = (text: string, field: string): string | undefined => {
    const parsed = z.looseObject({ [field]: z.union([z.string(), z.number(), z.boolean()]).transform(String) }).safeParse(parseJsonOr(text, undefined));
    return parsed.success ? parsed.data[field] : undefined;
};

const boundaryOf = (type: string): string | undefined => {
    const match = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(type);
    return match?.[1] ?? match?.[2];
};

// A multipart body's text field by name; a file part never, whatever it is called.
const multipartField = (text: string, boundary: string, field: string): string | undefined => {
    for (const part of text.split(`--${boundary}`)) {
        const split = part.indexOf("\r\n\r\n");
        const headers = split === -1 ? "" : part.slice(0, split);
        const name = /\bname="([^"]*)"/iu.exec(headers)?.[1];
        if (name === field && !/\bfilename\*?=/iu.test(headers)) {
            return part.slice(split + 4).replace(/\r\n$/u, "");
        }
    }
    return undefined;
};

// One field of the body, by the body's own type, else of the query.
const fieldOf = (head: BodyHead | undefined, type: string, query: URLSearchParams, field: string): string | undefined => {
    const fromBody = (): string | undefined => {
        if (head === undefined) {
            return undefined;
        }
        if (/^multipart\/form-data/iu.test(type)) {
            const boundary = boundaryOf(type);
            return boundary === undefined ? undefined : multipartField(head.text, boundary, field);
        }
        if (/^application\/x-www-form-urlencoded/iu.test(type)) {
            return new URLSearchParams(head.text).get(field) ?? undefined;
        }
        return head.complete ? jsonField(head.text, field) : undefined;
    };
    return fromBody() ?? query.get(field) ?? undefined;
};

// What a request says: its declared field, else a JSON body whole (an embed with no text says something too); a form or
// an upload never whole.
const contentOf = (action: BrokerAction, head: BodyHead | undefined, type: string, query: URLSearchParams): string | undefined => {
    if (action.content === undefined) {
        return undefined;
    }
    const field = fieldOf(head, type, query, action.content.field);
    if (field !== undefined || head === undefined || !head.complete || /^(multipart|application\/x-www-form-urlencoded)/iu.test(type)) {
        return field;
    }
    return head.text.trim().startsWith("{") ? head.text : undefined;
};

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const answerReadable = (response: Response): boolean =>
    response.body !== null && !NULL_BODY_STATUS.has(response.status) && /json/iu.test(response.headers.get("content-type") ?? "");

// How a request went, by its status first and then by what a JSON answer says of itself.
const answerOutcome = (status: number, text: string | undefined): CallOutcome => {
    if (status >= 400) {
        const parsed = text === undefined ? undefined : refusalIn(text) ?? messageIn(text);
        return { outcome: "error", error: (parsed ?? `HTTP ${String(status)}`).slice(0, ERROR_TAIL) };
    }
    const refusal = text === undefined ? undefined : refusalIn(text);
    return refusal === undefined ? { outcome: "ok" } : { outcome: "error", error: refusal.slice(0, ERROR_TAIL) };
};

// A failed answer's own sentence, where it has one at the top: `message`, `error` or `description`.
const SentenceSchema = z.string().optional().catch(undefined);
const FailedAnswerSchema = z.looseObject({ message: SentenceSchema, error: SentenceSchema, description: SentenceSchema });
const messageIn = (text: string): string | undefined => {
    const parsed = FailedAnswerSchema.safeParse(parseJsonOr(text, undefined));
    return parsed.success ? (parsed.data.message ?? parsed.data.error ?? parsed.data.description) : undefined;
};

/**
 * The outward action one request performs, with the owner's verdict on it and the recorder for its answer; undefined
 * when the card declares no actions. A rule that cannot be read refuses, as every other unreadable policy here does.
 */
export const outwardRequest = async (deps: OutwardDeps, input: OutwardRequestInput): Promise<OutwardRequest | undefined> => {
    if (input.actions === undefined || input.actions.length === 0) {
        return undefined;
    }
    const declared = requestAction(input.actions, input.method, input.path);
    const after = declared?.channel !== undefined && "after" in declared.channel ? segmentAfter(input.path, declared.channel.after) : undefined;
    const base: OutboundCall = {
        provider: input.provider,
        type: declared?.action ?? UNDECLARED_ACTION,
        method: input.method,
        endpoint: input.path,
        ...opt("channelId", after),
    };
    let refusal: string | undefined;
    try {
        refusal = actionRefusal((await deps.actionRules?.()) ?? {}, base);
    } catch {
        refusal = "The owner's action rules could not be read, so this request was not sent. Do not retry: tell the owner.";
    }
    const type = input.request.headers.get("content-type") ?? "";
    const wantsBody = declared !== undefined && (declared.content !== undefined || (declared.channel !== undefined && "field" in declared.channel));
    let body = input.request.body;
    let head: Promise<BodyHead | undefined> = Promise.resolve(undefined);
    if (wantsBody && body !== null && !input.bodyTaken && deps.outbound !== undefined) {
        const [forward, read] = body.tee();
        body = forward;
        head = headOf(read, REQUEST_HEAD_BYTES);
    }
    const settle = (response: Response): Response => {
        const record = deps.outbound;
        if (record === undefined) {
            return response;
        }
        let answer = response;
        let text: Promise<string | undefined> = Promise.resolve(undefined);
        if (response.headers.get("x-intentic-gateway") === "refused") {
            text = response.clone().text();
        } else if (input.method !== "HEAD" && answerReadable(response) && response.body !== null) {
            const [give, read] = response.body.tee();
            answer = new Response(give, { status: response.status, statusText: response.statusText, headers: response.headers });
            text = headOf(read, ANSWER_HEAD_BYTES).then((each) => each.text);
        }
        void Promise.all([head, text])
            .then(([bodyHead, answerText]) => {
                const channel = declared?.channel !== undefined && "field" in declared.channel ? fieldOf(bodyHead, type, input.query, declared.channel.field) : undefined;
                record({
                    call: {
                        ...base,
                        ...opt("channelId", channel),
                        ...opt("content", declared === undefined ? undefined : contentOf(declared, bodyHead, type, input.query)),
                    },
                    conversationId: input.conversationId,
                    ...answerOutcome(response.status, answerText),
                });
            })
            .catch((error: Error) => deps.warn?.("credential gateway: a request's Activity row could not be put together", error));
        return answer;
    };
    return { refusal, body, settle };
};
