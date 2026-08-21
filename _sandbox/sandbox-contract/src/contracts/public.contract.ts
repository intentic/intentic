import { oc } from "@orpc/contract";
import { OkSchema, PublicListSchema, PublishResultSchema, PublishSchema, UnpublishSchema } from "../schemas.js";

// The workspace outbox, what `public/` currently holds and its address (see the public section in schemas.ts).
// `publish` copies a workspace file or directory in, creating the outbox if this is the first one; `unpublish`
// withdraws one and removes the outbox behind the last, so the directory's presence always means exactly "there
// is something published". There is no route to READ a published file: that is the whole point of the
// unauthenticated `public-<slot>` hostname, and a second, authenticated way in would just be the workspace file
// API with extra steps.
export const publicContract = {
    list: oc
        .route({
            method: "GET",
            path: "/public",
            summary: "What is published to the internet",
            description:
                "Everything currently in the outbox and the address it answers on. There is no call to read a published file back: it is served openly to anyone with the link, which is the entire point of having put it there.",
        })
        .output(PublicListSchema),
    publish: oc
        .route({
            method: "POST",
            path: "/public/publish",
            summary: "Put a file on the internet",
            description:
                "Copies a workspace file or folder into the outbox, where it is served to anyone with the link and no sign-in. Answers with the address.",
        })
        .input(PublishSchema)
        .output(PublishResultSchema),
    unpublish: oc
        .route({
            method: "POST",
            path: "/public/unpublish",
            summary: "Take something off the internet",
            description:
                "Withdraws one published entry. When the last one goes, the outbox goes with it, so its existing at all always means something is published.",
        })
        .input(UnpublishSchema)
        .output(OkSchema),
};
