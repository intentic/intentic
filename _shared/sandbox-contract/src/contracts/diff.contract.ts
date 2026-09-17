import { oc } from "@orpc/contract";
import { DerivedDiffSchema, DiffSourceQuerySchema } from "../schemas/diff.js";

// What a diff's two sides are besides text: the byte route (/diff/raw) is plain Hono since it streams a body; the
// derived-text route is here, answering both sides in one call so they render together.
export const diffContract = {
    derived: oc
        .route({
            method: "GET",
            path: "/diff/derived",
            summary: "Both sides of a document's diff, as text",
            description:
                "A document, spreadsheet, presentation or notebook that changed, both versions rendered to markdown the way an agent reads them, so the change can be shown as tracked changes instead of two downloads. The side on disk reuses the shadow the sandbox already keeps; a past version is rendered from its bytes and kept by content hash, so the same version is never rendered twice. A side nothing can read says why.",
        })
        .input(DiffSourceQuerySchema)
        .output(DerivedDiffSchema),
};
