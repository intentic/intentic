import type { ListenerContribution } from "@intentic/extension-manifest";

// Manifest listener contribution kept plain: tests care about the provider/event vocabulary, not the automation
// metadata, which just keeps the fixture on the public shape.
export const listenerContribution = (provider: string, eventTypes: readonly string[]): ListenerContribution => ({
    provider,
    events: eventTypes.map((type) => ({ type, label: type })),
    automation: {
        label: provider,
        channel: { label: "Channel", placeholder: "all channels" },
        starterPrompt: `Handle ${provider} events.`,
    },
});
