import { personasContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { hasSession } from "../browser/sessions/session-store.js";
import { versionedSettingsWrite } from "../seams/settings-versions.js";
import { stateRelPath } from "../state-paths.js";
import { reachablePersonas } from "./persona-reach.js";
import { personasDocument } from "./personas-store.js";
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
// Which persona a new chat belongs to is not here: it is read with what the chat runs on, in one call (agent.routeChat).

export const createPersonasRoutes = (services: Services) => {
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

    // Every write here is the Personas page's own, so each is committed as it lands (settings-versions.ts): left
    // uncommitted, a land touching personas.json was refused as the owner's edits. Only where the paths held nothing
    // uncommitted before it: a kit folder an agent's land left changes in is not the page's to commit unreviewed.
    const kitPath = (id: string): string => stateRelPath(".intentic/config/personas/", id);
    const versioned = <T>(paths: readonly string[], subject: string, write: () => Promise<T>): Promise<T> =>
        versionedSettingsWrite(services, paths, `Settings: ${subject}`, write);

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
            await versioned([personasDocument.path], `persona ${input.label ?? input.id}`, () => services.personas.upsert(input));
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const removed = await services.personas.get(input.id);
            await versioned([personasDocument.path, kitPath(input.id)], `removed persona ${removed?.label ?? input.id}`, async () => {
                await services.personas.remove(input.id);
                await removePersonaKit(root, input.id);
            });
            return { ok: true as const };
        }),
        kit: i.kit.handler(async ({ input }) => {
            const [prompt, skills] = await Promise.all([readPersonaPrompt(root, input.id), listPersonaSkills(root, input.id)]);
            return { prompt: prompt ?? "", skills: skills.map(({ name, description }) => ({ name, description })) };
        }),
        savePrompt: i.savePrompt.handler(async ({ input }) => {
            const persona = await requirePersona(input.id);
            // Emptying deletes the file; storing "" would leave it on a blank custom prompt, not "not written yet".
            await versioned([kitPath(input.id)], `persona ${persona.label ?? persona.id} prompt`, () =>
                input.prompt.trim() === "" ? removePersonaPrompt(root, input.id) : writePersonaPrompt(root, input.id, persona.label, input.prompt),
            );
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
            await versioned([kitPath(input.id)], `persona ${persona.label ?? persona.id} skill ${input.name}`, () =>
                writePersonaSkill(root, input.id, persona.label, { name: input.name, description: input.description, body: input.body }),
            );
            return { ok: true as const };
        }),
        removeSkill: i.removeSkill.handler(async ({ input }) => {
            await versioned([kitPath(input.id)], `removed skill ${input.name} from persona ${input.id}`, () => removePersonaSkill(root, input.id, input.name));
            return { ok: true as const };
        }),
    };
};
