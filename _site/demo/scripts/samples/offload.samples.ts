import type { GroupSamples } from "./context.ts";

export const offloadSamples: GroupSamples<`offload`> = () => ({
    kinds: undefined,
    runs: undefined,
    placement: { agent: `claude` },
});
