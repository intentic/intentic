import type { GroupSamples } from "./context.ts";

export const providersSamples: GroupSamples<`providers`> = () => ({
    models: { provider: `claude` },
    list: undefined,
});
