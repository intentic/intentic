import type { GroupSamples } from "./context.ts";

// The policy rewritten, then put back to the shipped text by an empty save.
export const safetySamples: GroupSamples<`safety`> = () => ({ policy: undefined, setPolicy: { text: `` }, log: undefined });
