import { oc } from "@orpc/contract";
import { ShareCreateSchema, SharedConversationSchema, ShareListSchema, ShareRemoveSchema, ShareUpdateSchema } from "../schemas/share.js";
import { OkSchema } from "../schemas/shared.js";

/* Conversations published as read-only pages (see schemas/share.ts).
 *
 * Its own group rather than two more routes on `public`, because the two speak different path spaces and mean
 * different things by "publish". The outbox's routes take a path in the workspace and copy the bytes at it; a
 * share takes a CONVERSATION ID and renders something that did not exist as a file until it was asked for.
 * Folding them together would have `publish` accept two unrelated kinds of input distinguished by a flag.
 *
 * There is no route to read a share back. The page is the read, it answers on the unauthenticated
 * `public-<slot>` hostname like every other published file, which is the point of having made one. */
export const shareContract = {
    list: oc
        .route({
            method: "GET",
            path: "/share",
            summary: "Conversations published as pages",
            description:
                "Every conversation that has been turned into a read-only page, with its link. There is no call to read one back: the page itself is the read, and it answers to anyone who has the link.",
        })
        .output(ShareListSchema),
    // Answers with the row it just wrote, link included, so the dialog can show the address without re-listing.
    create: oc
        .route({
            method: "POST",
            path: "/share",
            summary: "Publish a conversation",
            description:
                "Renders a conversation into a page anybody with the link can read, without signing in. Answers with the link, so nothing has to be listed again to find it.",
        })
        .input(ShareCreateSchema)
        .output(SharedConversationSchema),
    // Re-render an existing share from the conversation as it stands now. Same id, same link, new snapshot.
    update: oc
        .route({
            method: "POST",
            path: "/share/update",
            summary: "Refresh a published page",
            description: "Re-renders an existing page from the conversation as it stands now. Same link, newer contents.",
        })
        .input(ShareUpdateSchema)
        .output(SharedConversationSchema),
    remove: oc
        .route({
            method: "POST",
            path: "/share/remove",
            summary: "Unpublish a conversation",
            description: "Takes the page down, so the link stops answering.",
        })
        .input(ShareRemoveSchema)
        .output(OkSchema),
};
