import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

/* Outbound provider calls are the agent running curl in Bash (per the cli skills) — there is no typed send
 * path, so the audit tee sniffs the turn's tool events instead: match the command, pair it with its result by
 * tool-use id, and append one activity event. This is monitoring, not enforcement — a creatively-quoted
 * command can slip past; the shapes the skills teach are what the matchers parse.
 * ponytail: regex over shell text — heredocs and shell-variable URLs fall through to type "api.call" with no
 * content; upgrade to a real shell tokenizer only if real transcripts miss calls. */

// How much tool output survives into an error event's detail.
const ERROR_TAIL = 300;

export interface OutboundCall {
    readonly provider: string;
    readonly type: string;
    readonly method: string;
    readonly endpoint: string;
    readonly channelId?: string;
    readonly content?: string;
}

const matchDiscord = (command: string): OutboundCall | undefined => {
    const url = /https:\/\/discord\.com\/api\/v10(\/[^\s"'\\]*)/.exec(command);
    if (url === null) {
        return undefined;
    }
    const endpoint = (url[1] as string).split("?")[0] as string;
    const method = /-X\s+(GET|POST|PUT|PATCH|DELETE)/.exec(command)?.[1] ?? "GET";
    const channelId = /\/channels\/(\d+)/.exec(endpoint)?.[1];
    const payload = /-d\s+'([^']*)'/.exec(command)?.[1] ?? /-d\s+"((?:[^"\\]|\\.)*)"/.exec(command)?.[1];
    let content: string | undefined;
    if (payload !== undefined) {
        try {
            const parsed = JSON.parse(payload) as { content?: unknown };
            content = typeof parsed.content === "string" ? parsed.content : payload;
        } catch {
            content = payload;
        }
    }
    const type =
        method === "POST" && /\/channels\/\d+\/messages$/.test(endpoint)
            ? "message.send"
            : method === "GET" && /\/channels\/\d+\/messages/.test(endpoint)
              ? "messages.read"
              : method === "PUT" && endpoint.includes("/reactions/")
                ? "reaction.add"
                : "api.call";
    return {
        provider: "discord",
        type,
        method,
        endpoint,
        ...(channelId !== undefined ? { channelId } : {}),
        ...(content !== undefined ? { content } : {}),
    };
};

/* Slack's Web API is method-per-path (`/api/chat.postMessage`), not REST, so the method name IS the verb — no
 * HTTP-verb + path-shape inference to do. The channel rides in the body for a write and in the query for a
 * read, hence both lookups. */
const SLACK_TYPES: Readonly<Record<string, string>> = {
    "chat.postMessage": "message.send",
    "chat.update": "message.edit",
    "conversations.history": "messages.read",
    "conversations.replies": "messages.read",
    "reactions.add": "reaction.add",
    "reactions.remove": "reaction.remove",
};

const matchSlack = (command: string): OutboundCall | undefined => {
    const url = /https:\/\/slack\.com\/api(\/[^\s"'\\]*)/.exec(command);
    if (url === null) {
        return undefined;
    }
    const [path, query] = (url[1] as string).split("?");
    const endpoint = path as string;
    const method = /-X\s+(GET|POST|PUT|PATCH|DELETE)/.exec(command)?.[1] ?? "GET";
    const payload = /-d\s+'([^']*)'/.exec(command)?.[1] ?? /-d\s+"((?:[^"\\]|\\.)*)"/.exec(command)?.[1];
    let content: string | undefined;
    let channelId = /[?&]channel=([^&\s"']+)/.exec(query ?? "")?.[1];
    if (payload !== undefined) {
        try {
            const parsed = JSON.parse(payload) as { text?: unknown; channel?: unknown };
            content = typeof parsed.text === "string" ? parsed.text : payload;
            channelId = typeof parsed.channel === "string" ? parsed.channel : channelId;
        } catch {
            content = payload;
        }
    }
    return {
        provider: "slack",
        type: SLACK_TYPES[endpoint.replace("/", "")] ?? "api.call",
        method,
        endpoint,
        ...(channelId !== undefined ? { channelId } : {}),
        ...(content !== undefined ? { content } : {}),
    };
};

// One matcher per cli provider (the cli/providers.ts key space); the chat providers whose skills teach curl.
const matchers: readonly ((command: string) => OutboundCall | undefined)[] = [matchDiscord, matchSlack];

// The classifier, shared with the enforcing PreToolUse gate (guard/outbound-gate.ts) — one parser for audit
// and enforcement, so the two can never disagree about what a command is.
export const classifyOutboundCall = (command: string): OutboundCall | undefined => {
    for (const match of matchers) {
        const call = match(command);
        if (call !== undefined) {
            return call;
        }
    }
    return undefined;
};

// curl -s exits 0 on HTTP 4xx, so the response body is the status signal. Discord's error envelope is a JSON
// object with a numeric `code` and string `message`; Slack always answers 200 and puts the verdict in `ok`,
// which is why a `"ok": false` body has to be read as a failure here or every refused Slack call would log as
// a success. ponytail: the envelope sniff IS the HTTP-status heuristic; teach the skill `-w` if it ever
// misclassifies.
const outcomeOf = (output: string, isError: boolean | undefined): { outcome: "ok" | "error"; error?: string } => {
    if (isError === true) {
        return { outcome: "error", error: output.trim().slice(-ERROR_TAIL) };
    }
    try {
        const parsed = JSON.parse(output) as { code?: unknown; message?: unknown; ok?: unknown; error?: unknown };
        if (typeof parsed.code === "number" && typeof parsed.message === "string") {
            return { outcome: "error", error: parsed.message };
        }
        if (parsed.ok === false) {
            return { outcome: "error", error: typeof parsed.error === "string" ? parsed.error : "slack call failed" };
        }
    } catch {
        // Non-JSON output (empty 204 body, piped text) — no error envelope to read.
    }
    return { outcome: "ok" };
};

export interface OutboundSniffer {
    readonly observe: (event: AgentEvent) => void;
    // Record calls whose results never arrived (aborted turns).
    readonly flush: () => void;
}

// One per turn, teed into streamAgent. Appends are fire-and-forget — monitoring must never fail a turn.
// `turnId` is the turn that owns this sniffer (agent.routes.ts mints it): stamped on every call so the audit
// feed folds a turn's Discord sends into that turn's row rather than leaving them floating beside it.
export const createOutboundSniffer = (services: Services, turnId: string): OutboundSniffer => {
    const pending = new Map<string, OutboundCall>();
    let sessionId: string | undefined;
    const record = (call: OutboundCall, result?: { outcome: "ok" | "error"; error?: string }): void => {
        void services.activity
            .append({
                provider: call.provider,
                direction: "out",
                type: call.type,
                method: call.method,
                endpoint: call.endpoint,
                turnId,
                ...(call.channelId !== undefined ? { channelId: call.channelId } : {}),
                ...(call.content !== undefined ? { content: call.content } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(result !== undefined ? { outcome: result.outcome } : {}),
                ...(result?.error !== undefined ? { error: result.error } : {}),
            })
            .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));
    };
    return {
        observe: (event) => {
            if (event.kind === "session") {
                sessionId = event.sessionId;
                return;
            }
            if (event.kind === "tool_call" && event.name === "Bash" && event.target !== undefined) {
                const call = classifyOutboundCall(event.target);
                if (call !== undefined) {
                    pending.set(event.id, call);
                }
                return;
            }
            // Only a TERMINAL update settles the call — interim updates (live output snapshots) keep it pending.
            if (event.kind === "tool_call_update" && (event.status === "completed" || event.status === "failed")) {
                const call = pending.get(event.id);
                if (call === undefined) {
                    return;
                }
                pending.delete(event.id);
                const text = event.content?.find((entry) => entry.type === "text")?.text ?? "";
                record(call, outcomeOf(text, event.status === "failed"));
            }
        },
        flush: () => {
            for (const call of pending.values()) {
                record(call);
            }
            pending.clear();
        },
    };
};
