import type { WebchatMessage, WebchatPending, WebchatPublicConfig } from "@intentic/sandbox-contract/schemas/automations";
import { embedFailure, type EmbedEndpoint, embedUrl, fetchEmbedChallenge, fetchEmbedJson, type PowChallenge, WEBCHAT_EVENT } from "@intentic/sandbox-contract/embed";
import { createSseParser, type SseEvent } from "@intentic/sandbox-contract/sse";

// Widget's half of the wire: three calls against the daemon's public /webchat door, all subject to its origin
// allowlist. Failures carry the server's own sentence (EmbedError), not a status code.

// Slug for the three calls every embed makes; only the reply (SSE over POST) is this widget's own.
const SLUG = "webchat";

export const fetchConfig = (endpoint: EmbedEndpoint): Promise<WebchatPublicConfig> => fetchEmbedJson<WebchatPublicConfig>(embedUrl(endpoint, SLUG, "config"));

// Challenge is minted for one thread: the daemon signs the conversation id into the salt, so a solution can't move to
// another.
export const fetchChallenge = (endpoint: EmbedEndpoint, conversationId: string): Promise<PowChallenge> => fetchEmbedChallenge(endpoint, SLUG, "conversation", conversationId);

// Replies queued since `after`: what an approval-gated guest answers with, and where a human writing as the agent lands.
// Spends no challenge and starts no turn, so it is safe to call on a page the visitor is only reading.
export const fetchPending = (endpoint: EmbedEndpoint, conversationId: string, after: number): Promise<WebchatPending> =>
    fetchEmbedJson<WebchatPending>(`${embedUrl(endpoint, SLUG, "messages")}?conversation=${encodeURIComponent(conversationId)}&after=${after}`);

export interface ReplySink {
    // One chunk of the agent's answer, as it is written.
    readonly delta: (text: string) => void;
    // Turn held for the owner's approval; nothing streams. Carries the server's own wording.
    readonly pending: (notice: string) => void;
    // Turn reached an agent with no answer (errored, skipped, overlapping); unlike EmbedError, it was accepted.
    readonly failed: (notice: string) => void;
}

// The daemon ends every turn with a `done` frame, so a stream that closes without one was cut (a restart, a proxy's idle
// timeout): what arrived is kept, and the visitor is told the rest will not.
const CUT_SHORT = "The connection closed before the reply finished. Try again.";

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
    // SSE over POST: EventSource only GETs, so the reply is read off the fetch body with the contract's parser, which
    // rejoins a multi-line delta (one `data:` line per source line) with "\n" and takes any line ending a proxy left.
    let ready: SseEvent[] = [];
    const parser = createSseParser((event) => ready.push(event));
    const drain = (): boolean => {
        const events = ready;
        ready = [];
        for (const event of events) {
            // A block with no data line (a keepalive comment) carries nothing for the visitor.
            if (event.data === undefined) {
                continue;
            }
            if (event.event === WEBCHAT_EVENT.delta) {
                sink.delta(event.data);
            }
            if (event.event === WEBCHAT_EVENT.pending) {
                sink.pending(event.data);
            }
            if (event.event === WEBCHAT_EVENT.error) {
                sink.failed(event.data);
            }
            if (event.event === WEBCHAT_EVENT.done) {
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
        parser.feed(decoder.decode(value, { stream: true }));
        if (drain()) {
            // Turn ended; cancel rather than read to EOF, since the daemon closes the body right after.
            await reader.cancel().catch(() => undefined);
            return;
        }
    }
    parser.feed(decoder.decode());
    parser.end();
    if (!drain()) {
        sink.failed(CUT_SHORT);
    }
};
