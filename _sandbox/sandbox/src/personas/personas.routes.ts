import { type PersonaRoute, type PersonaRouteAsk, personasContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { hasSession } from "../browser/sessions/session-store.js";
import { reachablePersonas } from "./persona-reach.js";
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

// Sandbox's named personas: saving or removing a persona connects or disconnects nothing, since accounts are capabilities
// with their own lifecycle. What a persona owns is its kit folder, written by the routes below and removed with `remove`.
// Which persona a new chat belongs to; passed in rather than imported, since agent/ already reads this subsystem and
// importing back would cycle.
export type PersonaRouter = (ask: PersonaRouteAsk, held: readonly string[] | undefined, signal?: AbortSignal) => Promise<PersonaRoute>;

export const createPersonasRoutes = (services: Services, route: PersonaRouter) => {
    const i = implement(personasContract).$context<OrpcContext>();
    const root = services.workspace.root;

    // Every kit write goes through the persona first: an orphaned kit is unreachable, and its manifest needs the persona's
    // label. A missing persona 404s rather than being created, so this surface can't mint a persona by side effect.
    const requirePersona = async (id: string) => {
        const found = await services.personas.get(id);
        if (found === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no persona with that id, it may have been removed since this page was drawn" });
        }
        return found;
    };

    return {
        list: i.list.handler(async ({ context }) => {
            // A fenced member is shown the personas that work in the part of the workspace they hold, and nothing about
            // the others, down to the accounts they name.
            const [personas, capabilities] = await Promise.all([
                reachablePersonas(services, context.identity?.areas),
                services.capabilities.list(),
            ]);
            const fenced = context.identity?.areas !== undefined;
            const reachable = fenced ? new Set(personas.flatMap((persona) => persona.capabilities)) : undefined;
            // `hasSession`, not manifest presence: exists before login finishes, a cloned workspace's usual state.
            const connected = capabilities
                .filter((capability) => capability.kind === "browser" && hasSession(services.workspace.root, capability.id))
                .filter((capability) => reachable === undefined || reachable.has(capability.id))
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
        // Never throws: no personas, no model, a deadline are all "none" with a reason; the composer's chip is waiting.
        // Routed within the asker's own fence, so the persona it lands on is one they may actually send through.
        route: i.route.handler(({ input, context, signal }) => route(input, context.identity?.areas, signal)),

        kit: i.kit.handler(async ({ input }) => {
            const [prompt, skills] = await Promise.all([readPersonaPrompt(root, input.id), listPersonaSkills(root, input.id)]);
            return { prompt: prompt ?? "", skills: skills.map(({ name, description }) => ({ name, description })) };
        }),
        savePrompt: i.savePrompt.handler(async ({ input }) => {
            const persona = await requirePersona(input.id);
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
            const persona = await requirePersona(input.id);
            await writePersonaSkill(root, input.id, persona.label, { name: input.name, description: input.description, body: input.body });
            return { ok: true as const };
        }),
        removeSkill: i.removeSkill.handler(async ({ input }) => {
            await removePersonaSkill(root, input.id, input.name);
            return { ok: true as const };
        }),
    };
};
