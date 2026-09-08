// Wire format of an oRPC event iterator (`/events`, `/agent/attach`): `event: message` carries one JSON value, `event:
// done` ends iteration, `event: error` throws into the consumer. Written by hand rather than importing
// `encodeEventMessage`, a dependency the client doesn't declare.

const frame = (event: `message` | `done` | `error`, data?: unknown): string =>
    `event: ${event}\n${data === undefined ? `` : `data: ${JSON.stringify(data)}\n`}\n`;

/** One emitter's control over a live stream: emit values, or end it. */
export interface StreamSink {
    emit: (value: unknown) => void;
    close: () => void;
    readonly closed: boolean;
}

// Event-iterator response that runs as long as the consumer holds the body open. Teardown runs once, on whichever comes
// first: producer close, consumer cancel, or request abort (how the app drops a stream).
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
                    // Consumer went away between the check and the enqueue; the abort listener cleans up.
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
