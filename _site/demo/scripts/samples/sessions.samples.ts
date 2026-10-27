import type { GroupSamples } from "./context.ts";

export const sessionsSamples: GroupSamples<`sessions`> = () => ({
    list: { query: `checkout` },
    get: { id: `smoke` },
});
