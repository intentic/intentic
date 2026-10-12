import { sseEvents, sseJson } from "@intentic/sandbox-contract";

// Reads a daemon SSE/ndjson stream: reframes blank-line-separated `data: <JSON>` frames and parses each, through the
// contract's one SSE reader, which ends a stream silent past its heartbeat window rather than hanging on it.

// Reads a daemon stream as parsed ndjson records. An `event: error` frame becomes a `{ kind: "error", message }`
// record; malformed frames are skipped.
export async function* readDaemonStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    for await (const event of sseEvents(body)) {
        const parsed = sseJson(event);
        if (typeof parsed !== "object" || parsed === null) {
            continue;
        }
        const record = parsed as Record<string, unknown>;
        if (event.event === "error") {
            yield { kind: "error", message: typeof record["message"] === "string" ? record["message"] : "Provisioning failed." };
            continue;
        }
        yield record;
    }
}
