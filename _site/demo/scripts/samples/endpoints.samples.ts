import type { GroupSamples } from "./context.ts";

export const endpointsSamples: GroupSamples<`endpoints`> = () => ({
    trial: undefined,
    localModelFit: undefined,
    localModelPrefetch: { action: `start` },
    localModelDelete: { model: `unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf` },
    hostServers: undefined,
    // The whole recording's office GPU box (daemon/capabilities.ts).
    models: { id: `office-gpu` },
    // A server of the shop's own, whose vendor tells nothing of its credit.
    balance: { id: `office-gpu` },
});
