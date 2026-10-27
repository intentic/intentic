import type { GroupSamples } from "./context.ts";

export const runsSamples: GroupSamples<`runs`> = () => ({
    targets: undefined,
    start: { repo: `web`, target: `desktop`, device: `ada-pc` },
});
