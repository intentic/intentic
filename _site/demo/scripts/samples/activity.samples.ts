import type { GroupSamples } from "./context.ts";

export const activitySamples: GroupSamples<`activity`> = () => ({ list: { limit: `50` }, status: undefined });
