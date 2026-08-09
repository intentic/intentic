import { oc } from "@orpc/contract";
import { PersonasListSchema, PersonaIdParamSchema, PersonaSchema, OkSchema } from "../schemas.js";

/* The sandbox's named personas (PersonaSchema): which connected accounts each one speaks for, how it sounds,
 * whether it may publish. Deliberately a plain three-verb CRUD with no apply step, because a card provisions
 * NOTHING — unlike a capability, saving one connects nothing, installs nothing and spends nothing. It records a
 * decision about accounts that already exist.
 *
 * The file behind it is committed workspace config (personas/personas-store.ts), so these routes are one of
 * two equally supported ways to edit them: this, and opening the file in the editor like any other project
 * config. Neither is the "real" one — which is why `save` is a whole-card upsert rather than a field patch, so
 * a round trip through the UI leaves a diff a reviewer would recognise. */
export const personasContract = {
    list: oc.route({ method: "GET", path: "/personas" }).output(PersonasListSchema),
    // Upsert by id — re-saving the same id edits that card.
    save: oc.route({ method: "POST", path: "/personas" }).input(PersonaSchema).output(OkSchema),
    /* Removing a card takes away a persona, never an account: the login it named stays connected and reachable from
     * every other surface. What it CAN do is orphan a reference — an automation pinned to this id now names a
     * card that no longer exists — and the resolver reads that as "no accounts at all" rather than "all of
     * them", so the automation goes quiet instead of posting as somebody unintended. */
    remove: oc.route({ method: "DELETE", path: "/personas/{id}" }).input(PersonaIdParamSchema).output(OkSchema),
};
