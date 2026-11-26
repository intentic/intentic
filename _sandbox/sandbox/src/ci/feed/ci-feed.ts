import type { CiFeedEvent } from "@intentic/sandbox-contract/schemas/ci";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app-env.js";

// WHAT THE FORGES SAID, AS IT IS HEARD, FOR A PROGRAM (schemas/ci.ts CiFeedEventSchema, `GET /ci/feed`): a `run` frame
// for every finished run, from ../events.ts `dispatchCiRun` (the webhook's and the poller's alike), and a `job` frame for
// every job that ended, passed or failed, from the webhook (../webhook.routes.ts; the poller reads runs, not jobs). The
// Deployments extension's engine reads it to deploy the moment the job publishing its images passes. Nothing is kept:
// a reader that was away catches up on runs from `/ci/runs`, and the jobs it missed are gone. Listener automations are
// never fed job frames, which are many; this stream is the only place they go. (2026-11-25) Replaced the daemon's own
// deploy triggers, which this fed directly.

type Listener = (event: CiFeedEvent) => void;

const listeners = new Set<Listener>();

// Tells every open stream; a reader whose stream broke is the stream's to drop, never the publisher's to fail on.
export const publishCiFeed = (event: CiFeedEvent): void => {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch {
            // allow(silent-catch): a reader that went away is dropped by its own stream's abort; the publisher carries on
        }
    }
};

// Hears every frame from now on; answers the unsubscribe.
export const subscribeCiFeed = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};

// A comment line on a beat while nothing is said, so a proxy between (Cloudflare cuts an idle response at 100 s) keeps
// an idle stream open; a reader skips it, as SSE says comments are skipped.
const CI_FEED_KEEPALIVE_MS = 25_000;

// The stream: one `data:` line of JSON per frame, in the order they were heard, until the reader lets go.
export const ciFeedRoute = (keepAliveMs: number = CI_FEED_KEEPALIVE_MS) => async (c: Context<AppEnv>): Promise<Response> =>
    streamSSE(c, async (sse) => {
        // Frames go out one write at a time; a write to a stream the reader already closed is dropped.
        let tail: Promise<unknown> = Promise.resolve();
        // allow(silent-catch): the only failure is a reader that went away, which the abort below also ends
        const write = (text: string): void => void (tail = tail.then(() => sse.write(text)).catch(() => undefined));
        const stop = subscribeCiFeed((event) => write(`data: ${JSON.stringify(event)}\n\n`));
        // Said at once, so the headers go out and the reader knows it is subscribed before the first frame.
        write(": ci feed\n\n");
        const beat = setInterval(() => write(": keep-alive\n\n"), keepAliveMs);
        try {
            await new Promise<void>((resolve) => sse.onAbort(resolve));
        } finally {
            clearInterval(beat);
            stop();
        }
    });
