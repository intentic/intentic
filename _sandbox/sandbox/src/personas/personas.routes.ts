import { personasContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { hasSession } from "../browser/session-store.js";
import {
    listPersonaSkills,
    readPersonaPrompt,
    readPersonaSkill,
    removePersonaKit,
    removePersonaPrompt,
    removePersonaSkill,
    writePersonaPrompt,
    writePersonaSkill,
} from "./persona-kit.js";

// The sandbox's named personas. No apply step and no teardown: saving a card connects nothing and removing one
// disconnects nothing (personas.contract.ts says why at length) — the accounts themselves are capabilities and
// keep their own lifecycle. What a card DOES own is its kit folder, which the routes below write and `remove`
// takes with it.
export const createPersonasRoutes = (services: Services) => {
    const i = implement(personasContract).$context<OrpcContext>();
    const root = services.workspace.root;

    /* Every kit write goes through the card first, for two reasons that are really one: a kit belonging to no
     * persona is unreachable — nothing can wear it — so writing one would put the owner's prose somewhere no
     * list shows it; and the manifest the plugin loader needs carries the card's label, which only the card can
     * supply. Answering a missing card with a 404 rather than creating one keeps this surface unable to mint a
     * persona by side effect. */
    const card = async (id: string) => {
        const found = await services.personas.get(id);
        if (found === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no persona with that id — it may have been removed since this page was drawn" });
        }
        return found;
    };

    return {
        list: i.list.handler(async () => {
            const [personas, capabilities] = await Promise.all([services.personas.list(), services.capabilities.list()]);
            /* Which of the accounts these cards name can actually act right now. `hasSession` rather than mere
             * presence in the manifest: a browser capability exists from the moment it is added, and is only
             * usable once the owner has finished its guided login — which is exactly the state a cloned
             * workspace's whole roster sits in, so conflating the two would show every persona as ready on the one
             * occasion none of them are. */
            const connected = capabilities
                .filter((capability) => capability.kind === "browser" && hasSession(services.workspace.root, capability.id))
                .map((capability) => capability.id);
            return { personas, connected };
        }),
        save: i.save.handler(async ({ input }) => {
            await services.personas.upsert(input);
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input }) => {
            await services.personas.remove(input.id);
            await removePersonaKit(root, input.id);
            return { ok: true as const };
        }),

        // ---- the kit ----

        kit: i.kit.handler(async ({ input }) => {
            const [prompt, skills] = await Promise.all([readPersonaPrompt(root, input.id), listPersonaSkills(root, input.id)]);
            return { prompt: prompt ?? "", skills: skills.map(({ name, description }) => ({ name, description })) };
        }),
        savePrompt: i.savePrompt.handler(async ({ input }) => {
            const persona = await card(input.id);
            // An emptied box deletes the file. Storing "" instead would leave a card claiming a custom prompt and
            // running on a blank one, which is the state personaPrompt deliberately reads as "not written yet".
            if (input.prompt.trim() === "") {
                await removePersonaPrompt(root, input.id);
                return { ok: true as const };
            }
            await writePersonaPrompt(root, input.id, persona.label, input.prompt);
            return { ok: true as const };
        }),
        readSkill: i.readSkill.handler(async ({ input }) => {
            const skill = await readPersonaSkill(root, input.id, input.name);
            if (skill === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no such skill on that persona — it may have been removed since this list was drawn" });
            }
            return skill;
        }),
        saveSkill: i.saveSkill.handler(async ({ input }) => {
            const persona = await card(input.id);
            await writePersonaSkill(root, input.id, persona.label, { name: input.name, description: input.description, body: input.body });
            return { ok: true as const };
        }),
        removeSkill: i.removeSkill.handler(async ({ input }) => {
            await removePersonaSkill(root, input.id, input.name);
            return { ok: true as const };
        }),
    };
};
