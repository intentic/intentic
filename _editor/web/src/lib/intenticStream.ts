import { sseData, sseFrames } from "@intentic/sandbox-contract";
import { acquireStreamSlot } from "../features/sandbox/client/streamBudget";

// Reads a daemon `/intentic` SSE stream as parsed ndjson; malformed frames are skipped. One connection-pool permit
// per read, since these can hold a socket for minutes; released in the generator's `finally`, even on early break.
export async function* readIntenticLines(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    const slot = await acquireStreamSlot(`attach`);
    try {
        yield* framesOf(body);
    } finally {
        slot?.();
    }
}

async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    for await (const frame of sseFrames(body)) {
        const parsed = sseData(frame);
        if (typeof parsed !== `object` || parsed === null) {
            continue;
        }
        const record = parsed as Record<string, unknown>;
        // An oRPC failure arrives as an `event: error` frame; normalized to a kind:"error" line so callers stop.
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
