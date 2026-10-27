import type { GroupSamples } from "./context.ts";

export const ciSamples: GroupSamples<`ci`> = ({ pipeline }) => ({
    runs: undefined,
    jobs: pipeline,
    rerun: pipeline,
    cancel: pipeline,
    fix: pipeline,
});
