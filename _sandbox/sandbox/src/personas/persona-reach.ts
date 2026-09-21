import { fenceHoldsPersona, type Persona } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { Caller } from "../auth/auth.js";
import { foldersOf } from "../areas/areas-store.js";

// Which personas a person may act through, derived, never granted on its own. A persona lives somewhere
// (policy/persona-home.ts), a person holds areas, and the personas whose home their folders cover are the ones they
// wear. One derivation, read by the list that offers them, the router that picks one, and the run that refuses
// one, so a persona offered on screen is one the daemon will actually accept.
// Resolved through the live manifest on every ask, like the file fence: editing an area moves every holder at once.

export type PersonaReachDeps = Pick<Services, "areas" | "personas">;

const nameOf = (persona: Persona): string => persona.label ?? persona.id;

/**
 * The personas a holder of these areas may wear. Undefined is the whole workspace, the owner and the owner's own
 * tool, and with it every persona, including the ones homed at the root that no fence can cover.
 */
export const reachablePersonas = async (services: PersonaReachDeps, held: readonly string[] | undefined): Promise<Persona[]> => {
    const personas = await services.personas.list();
    if (held === undefined) {
        return personas;
    }
    const fence = foldersOf(await services.areas.list(), held);
    return personas.filter((persona) => fenceHoldsPersona(fence, persona));
};

// What a refusal can offer instead. A fence that reaches no persona says so rather than naming an empty list, which
// would read as a bug in the message.
const insteadTry = (personas: readonly Persona[]): string =>
    personas.length === 0
        ? "no assistant lives in the part of the workspace you hold; ask the sandbox owner for an area that has one"
        : `yours are: ${personas.map(nameOf).join(", ")}`;

/**
 * The refusal a caller meets on a persona their areas do not reach, and the one a guest meets on naming none at all:
 * an unpinned attended chat reaches every account, which is exactly what the narrowest role is not handed.
 * Costs nothing for an unfenced caller naming a persona, which is every owner-driven turn.
 */
export const refuseUnlessReachable = async (services: PersonaReachDeps, caller: Caller | undefined, actsAs: string | undefined): Promise<void> => {
    if (caller === undefined) {
        return;
    }
    const guest = caller.role === "guest";
    if (!guest && (actsAs === undefined || caller.areas === undefined)) {
        return;
    }
    const personas = await reachablePersonas(services, caller.areas);
    if (actsAs === undefined) {
        throw new ORPCError("FORBIDDEN", { message: `a guest speaks through one of its assistants: ${insteadTry(personas)}` });
    }
    if (!personas.some((persona) => persona.id === actsAs)) {
        throw new ORPCError("FORBIDDEN", { message: `"${actsAs}" does not work in the part of the workspace you hold; ${insteadTry(personas)}` });
    }
};
