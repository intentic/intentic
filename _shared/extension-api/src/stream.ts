import { sseData, sseFrames } from "@intentic/sandbox-contract";

// Reads a daemon SSE/ndjson stream: reframes blank-line-separated `data: <JSON>` frames and parses each, through the
// contract's one SSE reader, which ends a stream silent past its heartbeat window rather than hanging on it.

// Reads a daemon stream as parsed ndjson records. An `event: error` frame becomes a `{ kind: "error", message }`
// record; malformed frames are skipped.
export async function* readDaemonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    for await (const frame of sseFrames(body)) {
        const parsed = sseData(frame);
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
