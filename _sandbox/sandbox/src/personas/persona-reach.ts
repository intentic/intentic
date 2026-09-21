import { fenceHoldsPersona, type Persona } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { Caller } from "../auth/auth.js";
import { foldersOf } from "../areas/areas-store.js";

// Which persona cards a person may act through — derived, never granted on its own. A card lives somewhere
// (policy/persona-home.ts), a person holds areas, and the cards whose home their folders cover are the ones they
// wear. One derivation, read by the list that offers the cards, the router that picks one, and the run that refuses
// one, so a card offered on screen is a card the daemon will actually accept.
// Resolved through the live manifest on every ask, like the file fence: editing an area moves every holder at once.

export type PersonaReachDeps = Pick<Services, "areas" | "personas">;

const nameOf = (card: Persona): string => card.label ?? card.id;

/**
 * The cards a holder of these areas may wear. Undefined is the whole workspace — the owner, the owner's own tool —
 * and with it every card, including the ones homed at the root that no fence can cover.
 */
export const reachableCards = async (services: PersonaReachDeps, held: readonly string[] | undefined): Promise<Persona[]> => {
    const cards = await services.personas.list();
    if (held === undefined) {
        return cards;
    }
    const fence = foldersOf(await services.areas.list(), held);
    return cards.filter((card) => fenceHoldsPersona(fence, card));
};

// What a refusal can offer instead. A fence that reaches no card says so rather than naming an empty list, which
// would read as a bug in the message.
const insteadTry = (cards: readonly Persona[]): string =>
    cards.length === 0
        ? "no assistant lives in the part of the workspace you hold; ask the sandbox owner for an area that has one"
        : `yours are: ${cards.map(nameOf).join(", ")}`;

/**
 * The refusal a caller meets on a card their areas do not reach, and the one a desk meets on naming no card at all:
 * an unpinned attended chat reaches every account, which is exactly what the narrowest tier is not handed.
 * Costs nothing for an unfenced caller naming a card, which is every owner-driven turn.
 */
export const refuseUnlessReachable = async (services: PersonaReachDeps, caller: Caller | undefined, actsAs: string | undefined): Promise<void> => {
    if (caller === undefined) {
        return;
    }
    const desk = caller.role === "desk";
    if (!desk && (actsAs === undefined || caller.areas === undefined)) {
        return;
    }
    const cards = await reachableCards(services, caller.areas);
    if (actsAs === undefined) {
        throw new ORPCError("FORBIDDEN", { message: `a desk speaks through one of its assistants: ${insteadTry(cards)}` });
    }
    if (!cards.some((card) => card.id === actsAs)) {
        throw new ORPCError("FORBIDDEN", { message: `"${actsAs}" does not work in the part of the workspace you hold; ${insteadTry(cards)}` });
    }
};
