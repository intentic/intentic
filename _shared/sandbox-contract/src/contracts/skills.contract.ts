import { oc } from "@orpc/contract";
import { SkillBodySchema, SkillDraftSchema, SkillIdSchema, SkillRemoveSchema, SkillsListSchema } from "../schemas/settings.js";
import { OkSchema } from "../schemas/shared.js";

// What the agent knows and which half the owner controls; `list` joins four sources (settings, owner's own, plugin
// checkouts, extension folders). The enabled half rides settings' `skills` array; `save`/`remove` write text and that
// array together. `read` takes the id in the query, since an id can name an owner and won't fit a path template.
export const skillsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/skills",
            summary: "What the agent knows how to do",
            description:
                "Every skill available here and whether it is switched on, joined from all four places they come from: the owner's own, the settings, plugins a connection installed, and folders inside extensions.",
        })
        .output(SkillsListSchema),
    read: oc
        .route({
            method: "GET",
            path: "/skills/read",
            summary: "Read one skill",
            description:
                "The full text of a single skill. The name travels in the query rather than the address, because a name can carry the owner it came from and that will not fit in a path.",
        })
        .input(SkillIdSchema)
        .output(SkillBodySchema),
    // Upsert by name; renaming saves under a new name and deletes the old. Saving switches a skill on.
    save: oc
        .route({
            method: "POST",
            path: "/skills",
            summary: "Write a skill",
            description:
                "Creates or rewrites a skill by name, and switches it on, because you wrote it in order to use it. Renaming is saving under the new name and deleting the old.",
        })
        .input(SkillDraftSchema)
        .output(OkSchema),
    remove: oc
        .route({
            method: "POST",
            path: "/skills/remove",
            summary: "Delete a skill",
            description:
                "Removes the text and takes it off the enabled list in one step, so a screen never has to sequence two calls and never leaves one half done.",
        })
        .input(SkillRemoveSchema)
        .output(OkSchema),
};
