import { oc } from "@orpc/contract";
import {
    OkSchema,
    PersonaIdParamSchema,
    PersonaKitSchema,
    PersonaPromptSchema,
    PersonaSchema,
    PersonasListSchema,
    PersonaSkillBodySchema,
    PersonaSkillNameSchema,
    PersonaSkillSchema,
} from "../schemas.js";

/* The sandbox's named personas (PersonaSchema): which connected accounts each one speaks for, what a session
 * wearing it may do, where it works, and what it is told. The card half is a plain three-verb CRUD with no apply
 * step, because a card provisions NOTHING, unlike a capability, saving one connects nothing, installs nothing
 * and spends nothing. It records a decision about accounts that already exist.
 *
 * The file behind it is committed workspace config (personas/personas-store.ts), so these routes are one of
 * two equally supported ways to edit them: this, and opening the file in the editor like any other project
 * config. Neither is the "real" one, which is why `save` is a whole-card upsert rather than a field patch, so
 * a round trip through the UI leaves a diff a reviewer would recognise.
 *
 * THE KIT ROUTES BELOW EDIT FILES, not the card, and they are here rather than on the skills contract because
 * what they write belongs to one persona: its prompt, and the skills only its turns can reach
 * (personas/persona-kit.ts). The sandbox's `skills` domain answers "what does the agent know" for every chat;
 * this answers "what does this card carry", and the two lists are different questions with different answers.
 *
 * Per-verb routes rather than one whole-kit PUT: a kit is a directory of files somebody edits one at a time, and
 * a save that shipped the whole folder would make an edit to one skill capable of deleting another. */
export const personasContract = {
    list: oc.route({ method: "GET", path: "/personas" }).output(PersonasListSchema),
    // Upsert by id, re-saving the same id edits that card.
    save: oc.route({ method: "POST", path: "/personas" }).input(PersonaSchema).output(OkSchema),
    /* Removing a card takes away a persona, never an account: the login it named stays connected and reachable from
     * every other surface. What it CAN do is orphan a reference, an automation pinned to this id now names a
     * card that no longer exists, and the resolver reads that as "no accounts at all" rather than "all of
     * them", so the automation goes quiet instead of posting as somebody unintended. */
    /* Removing a card takes away a persona, never an account: the login it named stays connected and reachable from
     * every other surface. It DOES take the card's kit with it, a folder no card can reach is a folder no list
     * shows, and leaving the owner's prompt and skills orphaned on disk is worse than deleting what they just
     * asked to delete. */
    remove: oc.route({ method: "DELETE", path: "/personas/{id}" }).input(PersonaIdParamSchema).output(OkSchema),

    // ---- the kit: what this card is told, and the skills only it reaches ----

    kit: oc.route({ method: "GET", path: "/personas/{id}/kit" }).input(PersonaIdParamSchema).output(PersonaKitSchema),
    // An empty prompt DELETES the file rather than storing a blank one, so "custom with nothing written" is one
    // state instead of two, the resolver falls back to the sandbox's prompt for it (personas.ts personaPrompt).
    savePrompt: oc.route({ method: "POST", path: "/personas/{id}/prompt" }).input(PersonaPromptSchema).output(OkSchema),
    readSkill: oc.route({ method: "GET", path: "/personas/{id}/skills/read" }).input(PersonaSkillNameSchema).output(PersonaSkillBodySchema),
    // Upsert by name, like the sandbox's own skills, and with no enabled list to write, because a kit skill is
    // on exactly when its persona is worn. That is what "specific to that persona" has to mean.
    saveSkill: oc.route({ method: "POST", path: "/personas/{id}/skills" }).input(PersonaSkillSchema).output(OkSchema),
    removeSkill: oc.route({ method: "POST", path: "/personas/{id}/skills/remove" }).input(PersonaSkillNameSchema).output(OkSchema),
};
