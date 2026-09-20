import { z } from "zod";
import { foldPath } from "../policy/fence-paths.js";
import { entryId } from "./internal.js";

// A named part of the workspace: the unit a person's reach is granted in. Named rather than listed per member because
// a folder list on every row makes each new folder an edit per member, and two rows meant to see the same thing drift
// apart the first time one is updated and the other isn't.
// An area is not a credential and holds none; what it holds is a decision about who sees which folders, which is why
// the file is tracked and a change to it shows up in review.

// Workspace-relative, forward-slash, no climb. Checked rather than rewritten: a transform here would make the route's
// wire shape inexpressible, and two builds compare surfaces by that shape. The route folds what it writes instead, so
// two spellings of one folder still cannot make two entries.
export const AreaFolderSchema = z
    .string()
    .min(1)
    .max(200)
    .refine((raw) => (foldPath(raw) ?? "") !== "", {
        message: "a folder is workspace-relative and inside the workspace; the workspace root is what naming no area already means",
    });

export const AreaSchema = z.object({
    id: entryId.describe("The area's id, the name a member row points at."),
    label: z.string().max(60).optional().describe("What to call it on screen. Absent falls back to the id, which somebody chose anyway."),
    brief: z
        .string()
        .max(200)
        .optional()
        .describe("What this part of the workspace is, in one line, so whoever grants it can tell what they are handing over."),
    folders: z
        .array(AreaFolderSchema)
        .min(1)
        .max(50)
        .describe(
            "The folders it admits, workspace-relative. At least one: an area naming nothing would be a grant with no reader, and the way to grant everything is to name no area at all.",
        ),
});
export type Area = z.infer<typeof AreaSchema>;

export const AreasListSchema = z.object({
    areas: z.array(AreaSchema).describe("Every named part of the workspace this sandbox grants access in."),
});

export const AreaIdParamSchema = z.object({ id: entryId.describe("Which area.") });
