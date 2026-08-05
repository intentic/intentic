// Low-level SSE framing for the daemon's streamed routes (oRPC eventIterator over HTTP): frames separated by
// a blank line, each carrying one `data: <JSON>` line. Protocol-only (no domain shapes) — shared by every
// consumer of the wire: the web's chat/intentic streams and the ACP bridge's daemon client.

// Yields each raw SSE frame (the text between blank-line separators) as it arrives, reassembling frames split
// across network chunks.
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- streaming reader; each chunk must be awaited in order as it arrives
        const { done, value } = await reader.read();
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
