import { sseData, sseFrames } from "@intentic/sandbox-contract";
import { acquireStreamSlot } from "./sandbox/streamBudget";

/* Reads a daemon `/intentic` SSE stream as parsed ndjson objects: the daemon emits one `data: <JSON>` frame
 * per line. Shared by the live-plan and the deployments reads (both consume `intentic` ndjson over the
 * sandbox client). Malformed frames are skipped.
 *
 * ONE PERMIT PER READ, because these are the app's LONGEST connections and nothing was counting them. A
 * capability apply, a VPN dial, an infra apply and, worst of all, `manageMachineSandbox` rebuilding a sandbox
 * all hold a socket for the MINUTES their image takes to pull, and a browser has six per origin on http/1.1.
 * A rebuild started from the UI was therefore enough, on its own, to take the last connection the workspace had
 * left and freeze every other read in every window until it finished, which is precisely the report this
 * answers ("everything hangs after a rebuild").
 *
 * Taken here rather than around the request, because here is the one place all eight consumers pass through,
 * and the request→headers hop is not where the minutes are. It is an accounting fix as much as a rationing one:
 * the NEXT stream now sees the pool is spent and moves the window to the tunnel instead of queueing behind an
 * image pull. Released by the generator's own `finally`, which runs when a consumer breaks out of its loop as
 * well as when the stream ends. */
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
        // An oRPC event-iterator failure arrives as an `event: error` frame (the stream's terminal error, not
        // a normal ndjson line). Normalize it to a kind:"error" line so callers surface it and stop, even
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
