import { outboxList, publish, unpublish } from "./outbox";
import { type Doors, okAfter } from "../doors";

// The workspace outbox (daemon/outbox.ts): what is on the internet, a chat page's Publish, the outbox view's Unpublish.
export const publicDoors = {
    list: () => outboxList(),
    publish: ({ path }) => publish(path),
    unpublish: ({ path }) => okAfter(() => unpublish(path)),
} satisfies Doors<`public`>;
