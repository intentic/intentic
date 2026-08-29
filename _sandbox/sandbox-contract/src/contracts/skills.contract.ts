import { oc } from "@orpc/contract";
import { SkillBodySchema, SkillDraftSchema, SkillIdSchema, SkillRemoveSchema, SkillsListSchema } from "../schemas/settings.js";
import { OkSchema } from "../schemas/shared.js";

/* WHAT THE AGENT KNOWS RIGHT NOW, and which half of it the owner controls.
 *
 * Its own domain rather than three more routes on `settings`, because only one of the four sources it reads is
 * the settings file: the rest are the owner's own skill store, the plugin checkouts a capability cloned, and the
 * skills folders inside installed extensions. `list` is the join of all four (skill-inventory.ts).
 *
 * The ENABLED half still rides the settings object's `skills` array, that array is what the reconciler
 * converges and what the boot path already reads, so a switch on this list is an ordinary settings write and
 * there is exactly one place that decides which skills exist on disk. `save` and `remove` write the text AND
 * that array together, which is why they are here rather than being two calls a screen has to sequence.
 *
 * `read` is a GET with the id in the query rather than in the path: an id can name an owner
 * (`extension:intentic.knowledge:knowledge`), and a path template cannot carry those segments. */
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
    // Upsert by name: saving over an existing skill rewrites it, which is also how one is renamed (the old name
    // is a different skill and is deleted on its own). A saved skill is switched ON, you wrote it to use it.
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
