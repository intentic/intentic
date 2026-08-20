/* The wire format of an oRPC event iterator, which is what `/events` and `/agent/attach` are on the contract
 * (`eventIterator(SystemEventSchema)`, `eventIterator(AttachFrameSchema)`). The client decodes a
 * `text/event-stream` body back into a typed async iterator: `event: message` frames carry one yielded value as
 * JSON, `event: done` ends the iteration, `event: error` throws into the consumer.
 *
 * Written out here rather than imported from `@orpc/standard-server` (which exports `encodeEventMessage`)
 * because that package is a transitive dependency of the client, not one web declares, and three lines of
 * framing is a smaller thing to own than a dependency the app itself never needs. JSON.stringify emits no raw
 * newlines, so a value is always a single `data:` line. */

const frame = (event: `message` | `done` | `error`, data?: unknown): string =>
    `event: ${event}\n${data === undefined ? `` : `data: ${JSON.stringify(data)}\n`}\n`;

/** One emitter's control over a live stream: yield values, or end it. */
export interface StreamSink {
    emit: (value: unknown) => void;
    close: () => void;
    readonly closed: boolean;
}

/* An event-iterator response whose producer runs for as long as the consumer holds the body open.
 *
 * `start` gets the sink and returns its teardown (timers to clear). Teardown runs exactly once, on whichever
 * comes first: the producer closing, the consumer cancelling the body, or the request's signal aborting, which
 * is the one that matters most here, because that abort IS how the app drops a stream (a sandbox switch, a
 * reconnect, a chat tab closing). */
export const eventStream = (request: Request, start: (sink: StreamSink) => () => void): Response => {
    let teardown: (() => void) | undefined;
    let closed = false;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
            const push = (text: string): void => {
                try {
                    controller.enqueue(encoder.encode(text));
                } catch {
                    // The consumer went away between our check and the enqueue; the abort listener cleans up.
                }
            };
            const sink: StreamSink = {
                emit: (value) => {
                    if (!closed) {
                        push(frame(`message`, value));
                    }
                },
                close: () => {
                    if (closed) {
                        return;
                    }
                    closed = true;
                    push(frame(`done`));
                    controller.close();
                    teardown?.();
                },
                get closed() {
                    return closed;
                },
            };
            teardown = start(sink);
            request.signal.addEventListener(`abort`, () => {
                if (closed) {
                    return;
                }
                closed = true;
                controller.close();
                teardown?.();
            });
        },
        cancel: () => {
            closed = true;
            teardown?.();
        },
    });

    return new Response(stream, {
        status: 200,
        headers: { "content-type": `text/event-stream`, "cache-control": `no-cache`, connection: `keep-alive` },
    });
};
