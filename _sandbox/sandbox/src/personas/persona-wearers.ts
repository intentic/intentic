import { isBuiltInPersona } from "@intentic/sandbox-contract/schemas/personas";
import { ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";

// WHO STILL WEARS A CARD, asked before it goes: an automation naming a card that no longer exists runs with no tools and
// no accounts (personas.ts `turnPersona`), silently, on every fire until somebody reads its transcript. So a card an
// automation or one of its sender rules names is not removed; the refusal names them, to re-point first.

type WearerDeps = Pick<Services, "automations">;

// The automations naming this card, as their own persona or a sender rule's, by id.
const automationsWearing = async (services: WearerDeps, id: string): Promise<string[]> =>
    (await services.automations.list())
        .filter((automation) => automation.actsAs === id || (automation.senders?.rules ?? []).some((rule) => rule.actsAs === id))
        .map((automation) => automation.id);

// Refuses removing a built-in, which is no card, and a card something still wears.
export const refuseUnlessRemovable = async (services: WearerDeps, id: string): Promise<void> => {
    if (isBuiltInPersona(id)) {
        throw new ORPCError("BAD_REQUEST", { message: `"${id}" is a built-in persona: it is always there and cannot be removed` });
    }
    const wearing = await automationsWearing(services, id);
    if (wearing.length > 0) {
        throw new ORPCError("CONFLICT", {
            message: `still worn by ${wearing.length === 1 ? "the automation" : "the automations"} ${wearing.join(", ")}: point ${wearing.length === 1 ? "it" : "them"} at another persona first, or they would run with no tools and no accounts`,
        });
    }
};

// Refuses a card taking a built-in's id: the built-in would win every turn that named it, so the card would never be worn.
export const refuseBuiltInId = (id: string): void => {
    if (isBuiltInPersona(id)) {
        throw new ORPCError("BAD_REQUEST", { message: `"${id}" is the id of a built-in persona; give this one another name` });
    }
};
