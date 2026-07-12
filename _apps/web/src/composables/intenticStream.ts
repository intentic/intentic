import { sseData, sseFrames } from "./sse";

// Reads a daemon `/intentic` SSE stream as parsed ndjson objects: the daemon emits one `data: <JSON>` frame
// per line. Shared by the live-plan and the deployments reads (both consume `intentic` ndjson over the
// sandbox client). Malformed frames are skipped.
export async function* readIntenticLines(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    for await (const frame of sseFrames(body)) {
        const parsed = sseData(frame);
        if (typeof parsed !== `object` || parsed === null) {
            continue;
        }
        const record = parsed as Record<string, unknown>;
        // An oRPC event-iterator failure arrives as an `event: error` frame (the stream's terminal error, not
        // a normal ndjson line). Normalize it to a kind:"error" line so callers surface it and stop — even
        // when the daemon couldn't emit its own error line (e.g. a failure before the CLI ran).
        if (
            frame
                .split(`\n`)
                .find((line) => line.startsWith(`event:`))
                ?.slice(6)
                .trim() === `error`
        ) {
            yield { kind: `error`, message: typeof record[`message`] === `string` ? record[`message`] : `Provisioning failed.` };
            continue;
        }
        yield record;
    }
}
