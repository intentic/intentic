import type { WebchatChallenge, WebchatMessage, WebchatPublicConfig } from "@intentic/sandbox-contract";

/* The widget's half of the wire. Four calls, all against the sandbox daemon's public /webchat routes, all
 * subject to its origin allowlist — a rejected origin is the FIRST thing a misconfigured embed hits, so every
 * failure here carries the server's own sentence rather than a status code. */

// The daemon answers a message with SSE over POST, which EventSource cannot do (it only GETs). So the reply is
// read off the fetch body directly — which is also what lets one function own the whole request/response pair.
export interface SseFrame {
    readonly event: string;
    readonly data: string;
}

// One SSE event block ("event: delta\ndata: hello\ndata: world") → a frame. Hono's writeSSE splits a payload
// on newlines into one `data:` line each (per the SSE spec), so rejoining with "\n" is what restores an
// agent's multi-line text exactly. A block with no `data:` line at all (a bare comment/keepalive) is dropped.
export const parseSseBlock = (block: string): SseFrame | undefined => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).trimStart();
            continue;
        }
        if (line.startsWith("data:")) {
            // Exactly one optional leading space is part of the framing, per the spec — anything beyond it is
            // the agent's own indentation and must survive.
            const value = line.slice("data:".length);
            data.push(value.startsWith(" ") ? value.slice(1) : value);
        }
    }
    return data.length === 0 ? undefined : { event, data: data.join("\n") };
};

// Split whatever has arrived into complete event blocks plus the unterminated remainder to carry forward.
// Both \n\n and \r\n\r\n terminate a block; a chunk boundary can fall anywhere, including inside a delimiter.
export const splitSseBlocks = (buffer: string): { blocks: string[]; rest: string } => {
    const normalized = buffer.replaceAll("\r\n", "\n");
    const parts = normalized.split("\n\n");
    return { blocks: parts.slice(0, -1).filter((block) => block.trim() !== ""), rest: parts.at(-1) ?? "" };
};

// What the server said when it refused. The daemon answers every refusal as {"error": "..."} — the widget shows
// that sentence verbatim, because "origin not allowed" tells the site owner exactly what to fix and any wording
// invented here would not.
export class WebchatError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "WebchatError";
    }
}

const failure = async (response: Response): Promise<WebchatError> => {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    return new WebchatError(typeof body?.error === "string" ? body.error : `request failed (${response.status})`, response.status);
};

export interface Endpoint {
    readonly base: string;
    readonly automationId: string;
}

const url = ({ base, automationId }: Endpoint, path: string): string => `${base}/webchat/${encodeURIComponent(automationId)}/${path}`;

export const fetchConfig = async (endpoint: Endpoint): Promise<WebchatPublicConfig> => {
    const response = await fetch(url(endpoint, "config"));
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as WebchatPublicConfig;
};

// The challenge is minted FOR one visitor thread — the daemon signs the conversation id into the salt, so a
// solution can't be carried to another thread. Hence the id in the query rather than a bare GET.
export const fetchChallenge = async (endpoint: Endpoint, conversationId: string): Promise<WebchatChallenge> => {
    const response = await fetch(`${url(endpoint, "challenge")}?conversation=${encodeURIComponent(conversationId)}`);
    if (!response.ok) {
        throw await failure(response);
    }
    return (await response.json()) as WebchatChallenge;
};

export interface ReplySink {
    // One chunk of the agent's answer, as it is written.
    readonly delta: (text: string) => void;
    // The turn is being held for the owner's approval — nothing will stream. Carries the server's own wording.
    readonly pending: (notice: string) => void;
    /* The turn reached an agent and produced no answer — a wake that errored, one a guard skipped, one dropped
     * as overlapping. Carries the server's own wording, which is deliberately generic here: the real reason is
     * about the site owner's credentials or scripts and is kept for them (see the daemon's sse-stream.ts).
     *
     * Distinct from a thrown WebchatError, which means the message never reached an agent at all. Both end the
     * turn, and the difference is the difference between "we couldn't answer" and "we couldn't accept it". */
    readonly failed: (notice: string) => void;
}

/* Send one message and pump the reply into `sink` until the stream ends. Resolves when the turn is over, so
 * the caller can re-enable its composer on the same await — a thrown WebchatError means the message never
 * reached an agent, which is a different thing to say than an empty reply. */
export const sendMessage = async (endpoint: Endpoint, message: WebchatMessage, sink: ReplySink): Promise<void> => {
    const response = await fetch(url(endpoint, "message"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
    });
    if (!response.ok || response.body === null) {
        throw await failure(response);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const drain = (): boolean => {
        const { blocks, rest } = splitSseBlocks(buffer);
        buffer = rest;
        for (const block of blocks) {
            const frame = parseSseBlock(block);
            if (frame === undefined) {
                continue;
            }
            if (frame.event === "delta") {
                sink.delta(frame.data);
            }
            if (frame.event === "pending") {
                sink.pending(frame.data);
            }
            if (frame.event === "error") {
                sink.failed(frame.data);
            }
            if (frame.event === "done") {
                return true;
            }
        }
        return false;
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (drain()) {
            // The turn ended. Let the body go rather than reading to EOF — the daemon closes right after.
            await reader.cancel().catch(() => undefined);
            return;
        }
    }
    buffer += decoder.decode();
    drain();
};
