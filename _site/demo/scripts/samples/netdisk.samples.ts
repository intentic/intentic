import type { GroupSamples } from "./context.ts";

// The warehouse disk is mounted and unmounted again, so the run ends with it down as it started.
export const netdiskSamples: GroupSamples<`netdisk`> = () => ({
    list: undefined,
    mount: { id: `warehouse-nas` },
    unmount: { id: `warehouse-nas` },
});
