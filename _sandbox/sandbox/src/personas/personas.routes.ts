import { type PersonaRoute, type PersonaRouteAsk, personasContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { hasSession } from "../browser/sessions/session-store.js";
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

// Sandbox's named personas: saving or removing a card connects or disconnects nothing, since accounts are capabilities
// with their own lifecycle. What a card owns is its kit folder, written by the routes below and removed with `remove`.
// Which card a new chat belongs to; passed in rather than imported, since agent/ already reads this subsystem and
// importing back would cycle.
export type PersonaRouter = (ask: PersonaRouteAsk, signal?: AbortSignal) => Promise<PersonaRoute>;

export const createPersonasRoutes = (services: Services, route: PersonaRouter) => {
    const i = implement(personasContract).$context<OrpcContext>();
    const root = services.workspace.root;

    // Every kit write goes through the card first: an orphaned kit is unreachable, and its manifest needs the card's
    // label. A missing card 404s rather than being created, so this surface can't mint a persona by side effect.
    const card = async (id: string) => {
        const found = await services.personas.get(id);
        if (found === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no persona with that id, it may have been removed since this page was drawn" });
        }
        return found;
    };

    return {
        list: i.list.handler(async () => {
            const [personas, capabilities] = await Promise.all([services.personas.list(), services.capabilities.list()]);
            // `hasSession`, not manifest presence: exists before login finishes, a cloned workspace's usual state.
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
        // Never throws: no cards, no model, a deadline are all "none" with a reason; the composer's chip is waiting.
        route: i.route.handler(({ input, signal }) => route(input, signal)),

        kit: i.kit.handler(async ({ input }) => {
            const [prompt, skills] = await Promise.all([readPersonaPrompt(root, input.id), listPersonaSkills(root, input.id)]);
            return { prompt: prompt ?? "", skills: skills.map(({ name, description }) => ({ name, description })) };
        }),
        savePrompt: i.savePrompt.handler(async ({ input }) => {
            const persona = await card(input.id);
            // Emptying deletes the file; storing "" would leave it on a blank custom prompt, not "not written yet".
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
                throw new ORPCError("NOT_FOUND", { message: "no such skill on that persona, it may have been removed since this list was drawn" });
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
