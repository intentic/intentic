/* Reading a daemon SSE/ndjson stream — the transport half of `sandbox.request().body`. The daemon emits SSE
 * frames (blank-line separated, each a `data: <JSON>` line, an oRPC event-iterator failure as `event: error`),
 * so consuming a streamed apply/plan/provision means reframing + JSON-parsing. Pure (ReadableStream in, async
 * records out), no deps — extensions bundle it; the shim path never touches it. */

// A silent daemon — one that accepts the stream then sends nothing and never closes — would park reader.read()
// forever, hanging the consumer. A live daemon heartbeats (≤1s) over the stream, so no bytes for this long means
// the connection is dead: cancel the reader and end the generator instead of waiting indefinitely.
const SSE_IDLE_MS = 120_000;

// Yields each raw SSE frame (the text between blank-line separators), reassembling frames split across chunks.
// Ends (cancelling the reader) if the daemon goes silent past SSE_IDLE_MS, so a half-open stream can't hang.
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            let timer: ReturnType<typeof setTimeout>;
            const idle = new Promise<"idle">((resolve) => {
                timer = setTimeout(() => resolve("idle"), SSE_IDLE_MS);
            });
            const result = await Promise.race([reader.read(), idle]);
            clearTimeout(timer!);
            if (result === "idle") {
                return; // daemon went silent past the heartbeat window — end rather than hang
            }
            const { done, value } = result;
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let separator = buffer.indexOf("\n\n");
            while (separator !== -1) {
                yield buffer.slice(0, separator);
                buffer = buffer.slice(separator + 2);
                separator = buffer.indexOf("\n\n");
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
}

const dataOf = (frame: string): unknown => {
    const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
    if (line === undefined) {
        return undefined;
    }
    const payload = line.slice(5).trim();
    if (payload.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(payload);
    } catch {
        return undefined;
    }
};

// Reads a daemon stream as parsed ndjson records. An `event: error` frame is normalized to a
// `{ kind: "error", message }` record so callers surface it and stop even when the daemon couldn't emit its
// own error line; malformed frames are skipped.
export async function* readDaemonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    for await (const frame of sseFrames(body)) {
        const parsed = dataOf(frame);
        if (typeof parsed !== "object" || parsed === null) {
            continue;
        }
        const record = parsed as Record<string, unknown>;
        const isError =
            frame
                .split("\n")
                .find((line) => line.startsWith("event:"))
                ?.slice(6)
                .trim() === "error";
        if (isError) {
            yield { kind: "error", message: typeof record["message"] === "string" ? record["message"] : "Provisioning failed." };
            continue;
        }
        yield record;
    }
}
