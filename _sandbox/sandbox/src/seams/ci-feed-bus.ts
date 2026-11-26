import type { CiFeedEvent } from "@intentic/sandbox-contract/schemas/ci";

// WHAT THE FORGES SAID, AS IT IS HEARD (schemas/ci.ts CiFeedEventSchema), handed to whatever reads it in-process: the CI
// feed's own stream for a program (ci/feed/ci-feed.ts, `GET /ci/feed`) and an extension's event stream for a backend that
// declared `ci` (extensions/runtime/own.routes.ts). A frame is published by CI ingestion as it hears it (ci/events.ts,
// ci/webhook.routes.ts, ci/poller.ts); here, below both, so neither layer imports the other. Nothing is kept.

type Listener = (event: CiFeedEvent) => void;

const listeners = new Set<Listener>();

// Tells every reader; a reader whose stream broke is the stream's to drop, never the publisher's to fail on.
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
