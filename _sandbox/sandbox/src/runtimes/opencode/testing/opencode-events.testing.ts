import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { SelectedEvent, SubscribeOptions } from "@opencode/client/promise/api";

// Adapts a test-driven stream to the SDK's typed subscriptions. The connection event always passes, even when a
// subscriber selects only particular event types, just as it does on the real client's shared stream.
export const eventSubscription = (
    stream: (options?: SubscribeOptions) => AsyncIterable<OpenCodeEvent>,
): OpenCodeClient["event"]["subscribe"] =>
    async function* <Type extends Exclude<OpenCodeEvent["type"], "server.connected">>(options?: SubscribeOptions<Type>) {
        for await (const event of stream(options)) {
            if (event.type === "server.connected" || options?.types === undefined || options.types.some((type) => type === event.type)) {
                // SAFETY: the selection above admits only the requested event types and the mandatory connection event.
                yield event as SelectedEvent<OpenCodeEvent, Type | "server.connected">;
            }
        }
    };
