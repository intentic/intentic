import { shareCreate, shareList, shareRemove, shareUpdate } from "./outbox";
import { type Doors, okAfter } from "../doors";

// Conversations published as read-only pages (daemon/outbox.ts): the chat's Share dialog, and the preview extension's
// list of shares with its refresh and take-down.
export const shareDoors = {
    list: () => shareList(),
    create: ({ conversationId, title, detail }) => shareCreate(conversationId, title, detail),
    update: ({ id }) => shareUpdate(id),
    remove: ({ id }) => okAfter(() => shareRemove(id)),
} satisfies Doors<`share`>;
