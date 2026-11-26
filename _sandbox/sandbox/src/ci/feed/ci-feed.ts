import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../../app-env.js";
import { subscribeCiFeed } from "../../seams/ci-feed-bus.js";

// WHAT THE FORGES SAID, AS IT IS HEARD, FOR A PROGRAM (schemas/ci.ts CiFeedEventSchema, `GET /ci/feed`): a `run` frame
// for every finished run, from ../events.ts `dispatchCiRun` (the webhook's and the poller's alike), and a `job` frame for
// every job that ended, passed or failed, from the webhook (../webhook.routes.ts), and (2026-11-26) for every failed job
// of a main line's run still going that the poller lists where no webhook is live (../poller.ts). A failed job's frame
// carries what the forge said of its failure (`failed`). The Deployments extension's engine reads it to deploy the moment
// the job publishing its images passes; the pipelines extension hears the same frames on its event stream
// (`permissions.events: ["ci"]`, seams/ci-feed-bus.ts) for main's fix agent. Nothing is kept:
// a reader that was away catches up on runs from `/ci/runs`, and the jobs it missed are gone. Listener automations are
// never fed job frames, which are many; this stream is the only place they go. (2026-11-25) Replaced the daemon's own
// deploy triggers, which this fed directly.

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
