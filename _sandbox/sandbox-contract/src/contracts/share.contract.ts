import { oc } from "@orpc/contract";
import { OkSchema, ShareCreateSchema, ShareListSchema, ShareRemoveSchema, ShareUpdateSchema, SharedConversationSchema } from "../schemas.js";

/* Conversations published as read-only pages (see the share section in schemas.ts).
 *
 * Its own group rather than two more routes on `public`, because the two speak different path spaces and mean
 * different things by "publish". The outbox's routes take a path in the workspace and copy the bytes at it; a
 * share takes a CONVERSATION ID and renders something that did not exist as a file until it was asked for.
 * Folding them together would have `publish` accept two unrelated kinds of input distinguished by a flag.
 *
 * There is no route to read a share back. The page is the read — it answers on the unauthenticated
 * `public-<slot>` hostname like every other published file, which is the point of having made one. */
export const shareContract = {
    list: oc.route({ method: "GET", path: "/share" }).output(ShareListSchema),
    // Answers with the row it just wrote, link included, so the dialog can show the address without re-listing.
    create: oc.route({ method: "POST", path: "/share" }).input(ShareCreateSchema).output(SharedConversationSchema),
    // Re-render an existing share from the conversation as it stands now. Same id, same link, new snapshot.
    update: oc.route({ method: "POST", path: "/share/update" }).input(ShareUpdateSchema).output(SharedConversationSchema),
    remove: oc.route({ method: "POST", path: "/share/remove" }).input(ShareRemoveSchema).output(OkSchema),
};
