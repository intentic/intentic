// Reads a daemon SSE/ndjson stream: reframes blank-line-separated `data: <JSON>` frames and parses each. Pure
// (ReadableStream in, async records out), no deps.

// A live daemon heartbeats over the stream at least this often; no bytes for this long means the connection is dead.
const SSE_IDLE_MS = 120_000;

// Yields each raw SSE frame, reassembling frames split across chunks; ends (cancelling the reader) after SSE_IDLE_MS of
// silence.
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
                return; // daemon went silent past the heartbeat window: end rather than hang
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

// Reads a daemon stream as parsed ndjson records. An `event: error` frame becomes a `{ kind: "error", message }`
// record; malformed frames are skipped.
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
