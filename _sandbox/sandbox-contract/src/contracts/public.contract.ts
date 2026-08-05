import { oc } from "@orpc/contract";
import { OkSchema, PublicListSchema, PublishResultSchema, PublishSchema, UnpublishSchema } from "../schemas.js";

// The workspace outbox — what `public/` currently holds and its address (see the public section in schemas.ts).
// `publish` copies a workspace file or directory in, creating the outbox if this is the first one; `unpublish`
// withdraws one and removes the outbox behind the last, so the directory's presence always means exactly "there
// is something published". There is no route to READ a published file: that is the whole point of the
// unauthenticated `public-<slot>` hostname, and a second, authenticated way in would just be the workspace file
// API with extra steps.
export const publicContract = {
    list: oc.route({ method: "GET", path: "/public" }).output(PublicListSchema),
    publish: oc.route({ method: "POST", path: "/public/publish" }).input(PublishSchema).output(PublishResultSchema),
    unpublish: oc.route({ method: "POST", path: "/public/unpublish" }).input(UnpublishSchema).output(OkSchema),
};
