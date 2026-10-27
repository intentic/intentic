import { activityList, activityStatus } from "./activityFeed";
import type { Doors } from "../doors";

// The audit feed and the health of what feeds it, read-only as the daemon's are (daemon/activityFeed.ts).
export const activityDoors = {
    list: activityList,
    status: activityStatus,
} satisfies Doors<`activity`>;
