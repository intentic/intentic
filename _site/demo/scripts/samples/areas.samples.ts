import type { GroupSamples } from "./context.ts";

export const areasSamples: GroupSamples<`areas`> = () => ({
    list: undefined,
    save: { id: `smoke-area`, folders: [`web`] },
    remove: { id: `smoke-area` },
});
