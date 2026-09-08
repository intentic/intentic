import { oc } from "@orpc/contract";
import { SkillBodySchema, SkillDraftSchema, SkillIdSchema, SkillRemoveSchema, SkillsListSchema, SkillSwitchSchema } from "../schemas/settings.js";
import { OkSchema } from "../schemas/shared.js";

// What the agent knows and which half the owner controls; `list` joins every source (the owner's own, the settings,
// connections, plugin checkouts, extension folders, persona kits). A baked tool's switch rides settings' `skills`
// array; an own skill is on while the agent's copy of it exists, which `switch` moves and `save`/`remove` write
// together with the text. `read` takes the id in the query, since an id can name an owner and won't fit a path
// template.
export const skillsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/skills",
            summary: "What the agent knows how to do",
            description:
                "Every skill available here and whether it is switched on, joined from all the places they come from: the owner's own, the settings, plugins a connection installed, folders inside extensions, and persona kits.",
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
    // Upsert by name; renaming saves under a new name and deletes the old. A new skill starts on; rewriting keeps its
    // switch as it was.
    save: oc
        .route({
            method: "POST",
            path: "/skills",
            summary: "Write a skill",
            description:
                "Creates or rewrites a skill by name. A new one starts switched on, because you wrote it in order to use it; rewriting one you switched off leaves it off. Renaming is saving under the new name and deleting the old.",
        })
        .input(SkillDraftSchema)
        .output(OkSchema),
    switch: oc
        .route({
            method: "POST",
            path: "/skills/switch",
            summary: "Switch one of your own skills on or off",
            description:
                "Off takes the agent's copy away and keeps your text; on writes the copy back from it. Built-in tools are switched in the agent settings instead, and nothing else has a switch.",
        })
        .input(SkillSwitchSchema)
        .output(OkSchema),
    remove: oc
        .route({
            method: "POST",
            path: "/skills/remove",
            summary: "Delete a skill",
            description:
                "Removes the text and the agent's copy in one step, so a screen never has to sequence two calls and never leaves one half done.",
        })
        .input(SkillRemoveSchema)
        .output(OkSchema),
};
