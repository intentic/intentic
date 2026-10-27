import type { GroupSamples } from "./context.ts";

export const panelsSamples: GroupSamples<`panels`> = () => ({
    list: undefined,
    start: { repo: `web` },
    stop: { repo: `web` },
});
