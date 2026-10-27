import type { GroupSamples } from "./context.ts";

export const accessProfilesSamples: GroupSamples<`accessProfiles`> = () => ({ list: undefined, save: { id: `smoke-profile`, agents: `off` }, remove: { id: `smoke-profile` } });
