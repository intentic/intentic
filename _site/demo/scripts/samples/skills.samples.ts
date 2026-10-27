import type { Samples } from "../smoke-daemon.ts";
import type { GroupSamples } from "./context.ts";

// A skill of the owner's written, switched off and deleted again, so the list reads as it started.
const SKILL_SAMPLES: Samples[`skills`] = {
    list: undefined,
    read: { id: `release-notes` },
    save: { name: `smoke-skill`, description: `smoke`, body: `smoke` },
    switch: { name: `smoke-skill`, on: false },
    remove: { name: `smoke-skill` },
};

export const skillsSamples: GroupSamples<`skills`> = () => SKILL_SAMPLES;
