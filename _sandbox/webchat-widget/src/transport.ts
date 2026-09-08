import type { WebchatMessage, WebchatPublicConfig } from "@intentic/sandbox-contract";
import { embedFailure, type EmbedEndpoint, embedUrl, fetchEmbedChallenge, fetchEmbedJson, type PowChallenge } from "@intentic/sandbox-contract/embed";

// Widget's half of the wire: three calls against the daemon's public /webchat door, all subject to its origin
// allowlist. Failures carry the server's own sentence (EmbedError), not a status code.

// SSE over POST; EventSource only GETs, so the reply is read directly off the fetch body instead.
export interface SseFrame {
    readonly event: string;
    readonly data: string;
}

// One SSE event block to a frame; multi-line data (one `data:` line per source line, per spec) rejoins with "\n". A
// block with no `data:` line (a keepalive) is dropped.
export const parseSseBlock = (block: string): SseFrame | undefined => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice("event:".length).trimStart();
            continue;
        }
        if (line.startsWith("data:")) {
            // One optional leading space is spec framing; anything beyond it is the agent's own indentation.
            const value = line.slice("data:".length);
            data.push(value.startsWith(" ") ? value.slice(1) : value);
        }
    }
    return data.length === 0 ? undefined : { event, data: data.join("\n") };
};

// Splits into complete event blocks plus the unterminated remainder to carry forward. Both \n\n and \r\n\r\n terminate
// a block; a chunk boundary can fall inside one.
export const splitSseBlocks = (buffer: string): { blocks: string[]; rest: string } => {
    const normalized = buffer.replaceAll("\r\n", "\n");
    const parts = normalized.split("\n\n");
    return { blocks: parts.slice(0, -1).filter((block) => block.trim() !== ""), rest: parts.at(-1) ?? "" };
};

// Slug for the three calls every embed makes; only the reply (SSE over POST) is this widget's own.
const SLUG = "webchat";

export const fetchConfig = (endpoint: EmbedEndpoint): Promise<WebchatPublicConfig> => fetchEmbedJson<WebchatPublicConfig>(embedUrl(endpoint, SLUG, "config"));

// Challenge is minted for one thread: the daemon signs the conversation id into the salt, so a solution can't move to
// another.
export const fetchChallenge = (endpoint: EmbedEndpoint, conversationId: string): Promise<PowChallenge> => fetchEmbedChallenge(endpoint, SLUG, "conversation", conversationId);

export interface ReplySink {
    // One chunk of the agent's answer, as it is written.
    readonly delta: (text: string) => void;
    // Turn held for the owner's approval; nothing streams. Carries the server's own wording.
    readonly pending: (notice: string) => void;
    // Turn reached an agent with no answer (errored, skipped, overlapping); unlike EmbedError, it was accepted.
    readonly failed: (notice: string) => void;
}

// Sends one message and pumps the reply into `sink` until the stream ends; resolves when the turn is over. A thrown
// EmbedError means the message never reached an agent.
export const sendMessage = async (endpoint: EmbedEndpoint, message: WebchatMessage, sink: ReplySink): Promise<void> => {
    const response = await fetch(embedUrl(endpoint, SLUG, "message"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
    });
    if (!response.ok || response.body === null) {
        throw await embedFailure(response);
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
            // Turn ended; cancel rather than read to EOF, since the daemon closes the body right after.
            await reader.cancel().catch(() => undefined);
            return;
        }
    }
    buffer += decoder.decode();
    drain();
};
