import type { GroupSamples } from "./context.ts";

// ada-pc runs the shop's desktop app in the demo (runs.handler.ts): the run its Stop and log name is that one.
export const runsSamples: GroupSamples<`runs`> = () => ({
    targets: undefined,
    start: { repo: `web`, target: `desktop`, device: `ada-pc` },
    active: { device: `ada-pc` },
    stop: { repo: `web`, target: `desktop`, device: `ada-pc`, id: `desktop-4f1c2a` },
    output: { device: `ada-pc`, id: `desktop-4f1c2a` },
});
