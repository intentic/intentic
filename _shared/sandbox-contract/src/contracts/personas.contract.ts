import { oc } from "@orpc/contract";
import {
    PersonaIdParamSchema,
    PersonaKitSchema,
    PersonaPromptSchema,
    PersonaRouteAskSchema,
    PersonaRouteSchema,
    PersonaSchema,
    PersonaSkillBodySchema,
    PersonaSkillNameSchema,
    PersonaSkillSchema,
    PersonasListSchema,
} from "../schemas/personas.js";
import { OkSchema } from "../schemas/shared.js";

// Named personas (PersonaSchema): accounts each speaks for, what it may do, what it is told. Card CRUD provisions
// nothing, only a decision about existing accounts. The kit routes below edit its files (prompt, skills only its turns
// reach) per verb, not one whole-kit PUT, so one skill's edit cannot delete another.
export const personasContract = {
    list: oc
        .route({
            method: "GET",
            path: "/personas",
            summary: "The characters an agent can wear",
            description:
                "Each persona with the connected accounts it speaks for, what a conversation wearing it is allowed to do, and where it works.",
        })
        .output(PersonasListSchema),
    // Upsert by id, re-saving the same id edits that card.
    save: oc
        .route({
            method: "POST",
            path: "/personas",
            summary: "Create or edit a persona",
            description:
                "Writes the whole card; sending an id that exists edits it. Nothing is connected, installed or spent by saving one, because a persona only records a decision about accounts that already exist. It is stored as a file you can equally well edit by hand, which is why this writes the card whole rather than patching a field: a round trip through a screen should leave a change a reviewer recognises.",
        })
        .input(PersonaSchema)
        .output(OkSchema),
    // Never removes the account; an automation pinned to this id resolves as no accounts, and goes quiet.
    // Also deletes the persona's kit folder (prompt + skills), rather than leaving it orphaned on disk.
    remove: oc
        .route({
            method: "DELETE",
            path: "/personas/{id}",
            summary: "Delete a persona",
            description:
                "Takes away the character, never the accounts: every login it named stays connected. Its own prompt and skills go with it, since a folder nothing can reach is worse than deleting what somebody just asked to delete. Anything still pointed at it goes quiet rather than falling back to speaking as everyone.",
        })
        .input(PersonaIdParamSchema)
        .output(OkSchema),

    // Costs a model call, hence POST though a read; the composer applies or shows the answer per setting.
    route: oc
        .route({
            method: "POST",
            path: "/personas/route",
            summary: "Which persona a new chat belongs to",
            description:
                "Reads the message a chat is about to open with, and one line per persona, and names the card it belongs to, or none. Costs one small model call on the persona-routing list. Nothing is applied: the composer shows or applies the answer according to the persona routing setting.",
        })
        .input(PersonaRouteAskSchema)
        .output(PersonaRouteSchema),

    // The kit: what this card is told, and the skills only it reaches.

    kit: oc
        .route({
            method: "GET",
            path: "/personas/{id}/kit",
            summary: "What one persona carries",
            description:
                "The instructions this persona is given and the skills only its conversations can reach. A different question from what the agent knows generally, with a different answer.",
        })
        .input(PersonaIdParamSchema)
        .output(PersonaKitSchema),
    // An empty prompt deletes the file rather than storing a blank; it then falls back to the sandbox's own prompt.
    savePrompt: oc
        .route({
            method: "POST",
            path: "/personas/{id}/prompt",
            summary: "Write a persona's instructions",
            description:
                "Sets what this persona is told. Saving an empty one removes it entirely rather than storing a blank, so the persona simply falls back to the sandbox's own instructions.",
        })
        .input(PersonaPromptSchema)
        .output(OkSchema),
    readSkill: oc
        .route({
            method: "GET",
            path: "/personas/{id}/skills/read",
            summary: "Read one of a persona's skills",
            description: "The full text of a single skill belonging to this persona.",
        })
        .input(PersonaSkillNameSchema)
        .output(PersonaSkillBodySchema),
    // Upsert by name, no enabled list to write: a kit skill is on exactly when its persona is worn.
    saveSkill: oc
        .route({
            method: "POST",
            path: "/personas/{id}/skills",
            summary: "Write one of a persona's skills",
            description:
                "Creates or replaces a skill by name. There is nothing to switch on: a persona's skill is available exactly when that persona is worn, which is what belonging to it has to mean.",
        })
        .input(PersonaSkillSchema)
        .output(OkSchema),
    removeSkill: oc
        .route({
            method: "POST",
            path: "/personas/{id}/skills/remove",
            summary: "Delete one of a persona's skills",
            description: "Removes a single skill from this persona and leaves the rest of its kit alone.",
        })
        .input(PersonaSkillNameSchema)
        .output(OkSchema),
};
