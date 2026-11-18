import { procedure } from "../protocol/route-meta.js";
import {
    RoleIdParamSchema,
    RoleKitSchema,
    RolePromptSchema,
    RoleSchema,
    RoleSkillBodySchema,
    RoleSkillNameSchema,
    RoleSkillSchema,
    RolesListSchema,
} from "../schemas/roles.js";
import { OkSchema } from "../schemas/shared.js";

// Named roles (RoleSchema): accounts each speaks for, where it opens, what it is told; what it may reach is the access
// profiles that list it (access-profiles.ts `roles`). Card CRUD provisions nothing, only a decision about existing
// accounts. The paths keep the word they had before personas were renamed roles (2026-11-18), so an editor or a script
// written against a daemon from before calls the same addresses either side of the rename. The kit routes below edit its files (prompt, skills only its turns
// reach) per verb, not one whole-kit PUT, so one skill's edit cannot delete another.
export const rolesContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/personas",
            summary: "The characters an agent can wear",
            description:
                "Each role with the connected accounts it speaks for, where a conversation wearing it opens, and what it is told. What it may reach is the access profiles that list it.",
        })
        .meta({ guest: true })
        .output(RolesListSchema),
    // Upsert by id, re-saving the same id edits that card.
    save: procedure
        .route({
            method: "POST",
            path: "/personas",
            summary: "Create or edit a role",
            description:
                "Writes the whole card; sending an id that exists edits it. Nothing is connected, installed or spent by saving one, because a role only records a decision about accounts that already exist. It is stored as a file you can equally well edit by hand, which is why this writes the card whole rather than patching a field: a round trip through a screen should leave a change a reviewer recognises.",
        })
        .input(RoleSchema)
        .output(OkSchema),
    // Never removes the account; an automation pinned to this id resolves as no accounts, and goes quiet.
    // Also deletes the role's kit folder (prompt + skills), rather than leaving it orphaned on disk.
    remove: procedure
        .route({
            method: "DELETE",
            path: "/personas/{id}",
            summary: "Delete a role",
            description:
                "Takes away the character, never the accounts: every login it named stays connected. Its own prompt and skills go with it, since a folder nothing can reach is worse than deleting what somebody just asked to delete. Anything still pointed at it goes quiet rather than falling back to speaking as everyone.",
        })
        .input(RoleIdParamSchema)
        .output(OkSchema),

    // Which role a new chat belongs to is answered by `agent.routeChat`, in the same reading that chooses its model.

    // The kit: what this card is told, and the skills only it reaches.

    kit: procedure
        .route({
            method: "GET",
            path: "/personas/{id}/kit",
            summary: "What one role carries",
            description:
                "The instructions this role is given and the skills only its conversations can reach. A different question from what the agent knows generally, with a different answer.",
        })
        .input(RoleIdParamSchema)
        .output(RoleKitSchema),
    // An empty prompt deletes the file rather than storing a blank; it then falls back to the sandbox's own prompt.
    savePrompt: procedure
        .route({
            method: "POST",
            path: "/personas/{id}/prompt",
            summary: "Write a role's instructions",
            description:
                "Sets what this role is told. Saving an empty one removes it entirely rather than storing a blank, so the role simply falls back to the sandbox's own instructions.",
        })
        .input(RolePromptSchema)
        .output(OkSchema),
    readSkill: procedure
        .route({
            method: "GET",
            path: "/personas/{id}/skills/read",
            summary: "Read one of a role's skills",
            description: "The full text of a single skill belonging to this role.",
        })
        .input(RoleSkillNameSchema)
        .output(RoleSkillBodySchema),
    // Upsert by name, no enabled list to write: a kit skill is on exactly when its role is worn.
    saveSkill: procedure
        .route({
            method: "POST",
            path: "/personas/{id}/skills",
            summary: "Write one of a role's skills",
            description:
                "Creates or replaces a skill by name. There is nothing to switch on: a role's skill is available exactly when that role is worn, which is what belonging to it has to mean.",
        })
        .input(RoleSkillSchema)
        .output(OkSchema),
    removeSkill: procedure
        .route({
            method: "POST",
            path: "/personas/{id}/skills/remove",
            summary: "Delete one of a role's skills",
            description: "Removes a single skill from this role and leaves the rest of its kit alone.",
        })
        .input(RoleSkillNameSchema)
        .output(OkSchema),
};
