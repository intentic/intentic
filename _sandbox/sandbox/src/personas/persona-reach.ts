import { fenceHoldsPersona } from "@intentic/sandbox-contract/policy/persona-home";
import { isBuiltInPersona, type Persona } from "@intentic/sandbox-contract/schemas/personas";
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
 * tool, and with it every persona, including the ones homed at the root that no fence can cover. `assistants`, a
 * chatting guest's own list (docs/architecture/access.md), narrows that to the ones it names; it never adds one the
 * fence does not hold, since a guest's chat works inside the guest's own fence and could not reach that card's home.
 */
export const reachablePersonas = async (
    services: PersonaReachDeps,
    held: readonly string[] | undefined,
    assistants?: readonly string[] | undefined,
): Promise<Persona[]> => {
    const personas = await services.personas.list();
    const listed = assistants === undefined ? personas : personas.filter((persona) => assistants.includes(persona.id));
    if (held === undefined) {
        return listed;
    }
    const fence = foldersOf(await services.areas.list(), held);
    return listed.filter((persona) => fenceHoldsPersona(fence, persona));
};

/**
 * Why a list of assistants cannot be granted to a holder of these areas, or undefined when it can: every one must be a
 * card this sandbox has, working inside those areas. Absent is every assistant there, which needs no check here.
 */
export const assistantsRefusal = async (
    services: PersonaReachDeps,
    held: readonly string[] | undefined,
    assistants: readonly string[] | undefined,
): Promise<string | undefined> => {
    if (assistants === undefined) {
        return undefined;
    }
    const known = new Set((await services.personas.list()).map((persona) => persona.id));
    const unknown = assistants.filter((id) => !known.has(id));
    if (unknown.length > 0) {
        return `no such assistant: ${unknown.join(", ")}`;
    }
    const reached = new Set((await reachablePersonas(services, held)).map((persona) => persona.id));
    const outside = assistants.filter((id) => !reached.has(id));
    return outside.length === 0
        ? undefined
        : `${outside.join(", ")} ${outside.length === 1 ? "does" : "do"} not work in those areas: a guest's chat works inside the guest's own areas, so an assistant has to start in one of them`;
};

/** The assistants a caller's own list narrows them to: a chatting guest's, never anyone else's (a list on any other row says nothing). */
export const assistantsOf = (caller: Pick<Caller, "role" | "agents" | "assistants"> | undefined): readonly string[] | undefined =>
    caller?.role === "guest" && caller.agents !== "home" ? caller.assistants : undefined;

// What a refusal can offer instead. A fence that reaches no persona says so rather than naming an empty list, which
// would read as a bug in the message.
const insteadTry = (personas: readonly Persona[]): string =>
    personas.length === 0
        ? "no assistant lives in the part of the workspace you hold; ask the sandbox owner for an area that has one"
        : `yours are: ${personas.map(nameOf).join(", ")}`;

/**
 * The refusal a caller meets on a persona their areas do not reach, and the one a guest meets on naming none at all or
 * a built-in: an attended chat naming no card wears Full access, every account, which is exactly what the narrowest role
 * is not handed, and No accounts still holds the whole toolbox. Anyone else may wear either built-in, fenced or not:
 * they live nowhere, and the conversation's own fence still holds under them.
 * Costs nothing for an unfenced caller naming a persona, which is every owner-driven turn.
 */
export const refuseUnlessReachable = async (services: PersonaReachDeps, caller: Caller | undefined, actsAs: string | undefined): Promise<void> => {
    if (caller === undefined) {
        return;
    }
    // A home-only guest speaks to its own home conversation, which is no card (conversations/home/home-conversation.ts).
    const guest = caller.role === "guest" && caller.agents !== "home";
    if (!guest && (actsAs === undefined || isBuiltInPersona(actsAs) || caller.areas === undefined)) {
        return;
    }
    const personas = await reachablePersonas(services, caller.areas, assistantsOf(caller));
    if (actsAs === undefined || isBuiltInPersona(actsAs)) {
        throw new ORPCError("FORBIDDEN", { message: `a guest speaks through one of its assistants: ${insteadTry(personas)}` });
    }
    if (!personas.some((persona) => persona.id === actsAs)) {
        throw new ORPCError("FORBIDDEN", { message: `"${actsAs}" does not work in the part of the workspace you hold; ${insteadTry(personas)}` });
    }
};
