// Low-level SSE framing for the daemon's streamed routes (oRPC eventIterator over HTTP): frames separated by
// a blank line, each carrying one `data: <JSON>` line. Protocol-only (no domain shapes), shared by every
// consumer of the wire: the web's chat/intentic streams and the ACP bridge's daemon client.

// A live daemon writes to a stream at least this often (oRPC's keep-alive comment every 5 s, a heartbeat on the rest), so
// this long with no bytes means the connection is dead even though nothing closed it.
export const SSE_IDLE_MS = 120_000;

// Yields each raw SSE frame (the text between blank-line separators) as it arrives, reassembling frames split
// across network chunks. Ends, cancelling the reader, after `idleMs` of silence, so a reader of a daemon that went quiet
// without closing (a sleeping laptop's tunnel, a wedged proxy) finishes instead of hanging.
export async function* sseFrames(body: ReadableStream<Uint8Array>, idleMs: number = SSE_IDLE_MS): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<"idle">((resolve) => {
                timer = setTimeout(() => resolve("idle"), idleMs);
            });
            // oxlint-disable-next-line eslint/no-await-in-loop -- streaming reader; each chunk must be awaited in order as it arrives
            const result = await Promise.race([reader.read(), idle]);
            clearTimeout(timer);
            if (result === "idle" || result.done) {
                return;
            }
            buffer += decoder.decode(result.value, { stream: true });
            let separator = buffer.indexOf("\n\n");
            while (separator !== -1) {
                yield buffer.slice(0, separator);
                buffer = buffer.slice(separator + 2);
                separator = buffer.indexOf("\n\n");
            }
        }
    } finally {
        // allow(silent-catch): A stream already errored or closed has nothing left to cancel.
        await reader.cancel().catch(() => undefined);
    }
}

// The parsed JSON payload of a frame's `data:` line, or undefined for a frame with no data line, an empty
// payload, or malformed JSON (all cases the callers skip).
export const sseData = (frame: string): unknown => {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (dataLine === undefined) {
        return undefined;
    }
    const payload = dataLine.slice(5).trim();
    if (payload.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(payload);
    } catch {
        return undefined; // Skip a malformed frame.
    }
};
