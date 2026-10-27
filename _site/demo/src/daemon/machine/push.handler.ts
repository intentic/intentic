import { pushConfig, subscribePush, testPush, unsubscribePush } from "./push";
import type { Doors } from "../doors";

// Notifications to the owner's devices (daemon/push.ts): what a device needs to subscribe, its registration, and the test.
export const pushDoors = {
    config: ({ id }) => pushConfig(id),
    subscribe: (channel) => subscribePush(channel),
    unsubscribe: ({ id }) => unsubscribePush(id),
    test: () => testPush(),
} satisfies Doors<`push`>;
