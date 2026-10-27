import type { GroupSamples } from "./context.ts";

// A workspace file put on the internet and taken off again.
export const publicSamples: GroupSamples<`public`> = () => ({
    list: undefined,
    publish: { path: `web/src/pricing/plans.ts` },
    unpublish: { path: `plans.ts` },
});
