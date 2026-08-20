import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

/* Outbound provider calls are the agent running curl in Bash (per the cli skills), there is no typed send
 * path, so the audit tee sniffs the turn's tool events instead: match the command, pair it with its result by
 * tool-use id, and append one activity event. This is monitoring, not enforcement, a creatively-quoted
 * command can slip past; the shapes the skills teach are what the matchers parse.
 * ponytail: regex over shell text, heredocs and shell-variable URLs fall through to type "api.call" with no
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

/* Slack's Web API is method-per-path (`/api/chat.postMessage`), not REST, so the method name IS the verb, no
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

/* Telegram is method-per-path like Slack, but the path also carries the BOT TOKEN, `/bot<token>/sendMessage`.
 * So the endpoint recorded here is the METHOD ONLY: an activity feed is read by people and shipped in support
 * threads, and a credential that lands in it is a credential to rotate. The skills teach `$TELEGRAM_BOT_TOKEN`,
 * which never expands in the command text we see, but a hand-typed token must not leak either. */
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
    // The download endpoint (`/file/bot<token>/<path>`) names a file, not a method, its verb is the fetch.
    const endpoint = url[1] === undefined ? `/${url[2] as string}` : "/file";
    const method = /-X\s+(GET|POST|PUT|PATCH|DELETE)/.exec(command)?.[1] ?? (/\s-[dF]\s/.test(command) ? "POST" : "GET");
    const payload = /-d\s+'([^']*)'/.exec(command)?.[1] ?? /-d\s+"((?:[^"\\]|\\.)*)"/.exec(command)?.[1];
    // A file upload is multipart (`-F chat_id=…`), and a lookup puts the chat in the query, both are the same
    // fact under different syntax, so all three spellings resolve to one channelId.
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

/* WhatsApp is not curl at all: the paired socket lives in the gateway process and the skill teaches the
 * `whatsapp` CLI, so the shape to match is a bin invocation rather than a URL. Only the sending verbs record,
 * `chats` and `download` are reads, and a read that logged as an outbound send would teach the action rules to
 * lie. The endpoint is the subcommand, which is also what the `whatsapp.message.send` rule key matches on. */
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

// One matcher per cli provider (the cli/providers.ts key space); the chat providers whose skills teach curl,
// plus whatsapp, whose skill teaches a bin.
const matchers: readonly ((command: string) => OutboundCall | undefined)[] = [matchDiscord, matchSlack, matchTelegram, matchWhatsApp];

// The classifier, shared with the enforcing PreToolUse gate (guard/outbound-gate.ts), one parser for audit
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
// object with a numeric `code` and string `message`; Slack and Telegram both answer with an `ok` verdict in the
// body (Slack always over HTTP 200), which is why a `"ok": false` body has to be read as a failure here or
// every refused call would log as a success. The two name their reason differently. Slack `error`, Telegram
// `description`, so both are read. ponytail: the envelope sniff IS the HTTP-status heuristic; teach the skill
// `-w` if it ever misclassifies.
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

// One per turn, teed into streamAgent. Appends are fire-and-forget, monitoring must never fail a turn.
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
            // Only a TERMINAL update settles the call, interim updates (live output snapshots) keep it pending.
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
