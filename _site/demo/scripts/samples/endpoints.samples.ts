import type { GroupSamples } from "./context.ts";

export const endpointsSamples: GroupSamples<`endpoints`> = () => ({
    trial: undefined,
    localModelFit: undefined,
    localModelPrefetch: { action: `start` },
    hostServers: undefined,
    // The whole recording's office GPU box (daemon/capabilities.ts).
    models: { id: `office-gpu` },
});
