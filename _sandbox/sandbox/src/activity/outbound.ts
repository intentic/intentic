import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

// Outbound provider calls are the agent running curl in Bash; there's no typed send path, so this sniffs tool events,
// matching each command to its result by tool-use id. Monitoring, not enforcement: a creatively-quoted command can slip
// past the matchers. Regex over shell text, not a real tokenizer; heredocs and shell-variable URLs fall through to
// `api.call` with no content.

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

// Slack's API is method-per-path (`/api/chat.postMessage`), not REST verbs, so the method name is the type. Channel
// rides in the body for a write, in the query for a read; both are checked.
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

// Telegram's path carries the bot token (`/bot<token>/sendMessage`); only the method is recorded, never the full path,
// so even a hand-typed token can't leak.
const TELEGRAM_TYPES: Readonly<Record<string, string>> = {
    sendMessage: "message.send",
    sendDocument: "message.send",
    sendPhoto: "message.send",
    sendVideo: "message.send",
    sendAudio: "message.send",
    sendVoice: "message.send",
    editMessageText: "message.edit",
    setMessageReaction: "reaction.add",
    getFile: "file.read",
};

const matchTelegram = (command: string): OutboundCall | undefined => {
    const url = /https:\/\/api\.telegram\.org\/(file\/)?bot[^/\s"']*\/([^\s"'\\?]*)/.exec(command);
    if (url === null) {
        return undefined;
    }
    // The download endpoint (`/file/bot<token>/<path>`) names a file, not a method; its verb is the fetch.
    const endpoint = url[1] === undefined ? `/${url[2] as string}` : "/file";
    const method = /-X\s+(GET|POST|PUT|PATCH|DELETE)/.exec(command)?.[1] ?? (/\s-[dF]\s/.test(command) ? "POST" : "GET");
    const payload = /-d\s+'([^']*)'/.exec(command)?.[1] ?? /-d\s+"((?:[^"\\]|\\.)*)"/.exec(command)?.[1];
    // Upload puts chat_id in a form field, a lookup in the query; both resolve to the same channelId.
    let channelId = /-F\s+chat_id=([^\s"']+)/.exec(command)?.[1] ?? /[?&]chat_id=([^&\s"']+)/.exec(command)?.[1];
    let content: string | undefined;
    if (payload !== undefined) {
        try {
            const parsed = JSON.parse(payload) as { text?: unknown; chat_id?: unknown };
            content = typeof parsed.text === "string" ? parsed.text : payload;
            channelId = typeof parsed.chat_id === "string" || typeof parsed.chat_id === "number" ? String(parsed.chat_id) : channelId;
        } catch {
            content = payload;
        }
    }
    return {
        provider: "telegram",
        type: TELEGRAM_TYPES[endpoint.slice(1)] ?? "api.call",
        method,
        endpoint,
        ...(channelId !== undefined ? { channelId } : {}),
        ...(content !== undefined ? { content } : {}),
    };
};

// WhatsApp's skill drives the `whatsapp` CLI, not curl, so this matches a bin invocation, not a URL. Only
// send/send-file record; `chats`/`download` are reads. Endpoint is the subcommand, matching the `whatsapp.message.send`
// rule key.
const unquote = (value: string): string => value.replace(/^["']/, "").replace(/["']$/, "");

const matchWhatsApp = (command: string): OutboundCall | undefined => {
    const invocation = /(?:^|[;&|(]\s*)whatsapp\s+(send|send-file)\s+("[^"]+"|'[^']+'|\S+)\s+([\S\s]+)/.exec(command);
    if (invocation === null) {
        return undefined;
    }
    const rest = (invocation[3] as string).trim();
    return {
        provider: "whatsapp",
        type: "message.send",
        method: "POST",
        endpoint: `/${invocation[1] as string}`,
        channelId: unquote(invocation[2] as string),
        content: unquote(rest),
    };
};

// One matcher per cli provider (cli/providers.ts key space): curl-based chat providers, plus whatsapp's bin.
const matchers: readonly ((command: string) => OutboundCall | undefined)[] = [matchDiscord, matchSlack, matchTelegram, matchWhatsApp];

// Shared with the enforcing PreToolUse gate (guard/outbound-gate.ts): one parser, so audit and enforcement can't
// disagree.
export const classifyOutboundCall = (command: string): OutboundCall | undefined => {
    for (const match of matchers) {
        const call = match(command);
        if (call !== undefined) {
            return call;
        }
    }
    return undefined;
};

// `curl -s` exits 0 on HTTP 4xx, so the body is the status signal: Discord's envelope has numeric `code`/`message`;
// Slack and Telegram both answer `ok: false`, naming the reason `error` or `description` respectively.
const outcomeOf = (output: string, isError: boolean | undefined): { outcome: "ok" | "error"; error?: string } => {
    if (isError === true) {
        return { outcome: "error", error: output.trim().slice(-ERROR_TAIL) };
    }
    try {
        const parsed = JSON.parse(output) as { code?: unknown; message?: unknown; ok?: unknown; error?: unknown; description?: unknown };
        if (typeof parsed.code === "number" && typeof parsed.message === "string") {
            return { outcome: "error", error: parsed.message };
        }
        if (parsed.ok === false) {
            const reason = [parsed.error, parsed.description].find((each) => typeof each === "string");
            return { outcome: "error", error: reason ?? "the call was refused" };
        }
    } catch {
        // Non-JSON output (empty 204 body, piped text), no error envelope to read.
    }
    return { outcome: "ok" };
};

export interface OutboundSniffer {
    readonly observe: (event: AgentEvent) => void;
    // Record calls whose results never arrived (aborted turns).
    readonly flush: () => void;
}

// One per turn, teed into streamAgent; appends are fire-and-forget so monitoring never fails the turn. `turnId` (minted
// in agent.routes.ts) is stamped on every call so the feed folds a turn's sends into its own row.
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
            // Only a terminal update settles the call; interim updates (live output snapshots) keep it pending.
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
