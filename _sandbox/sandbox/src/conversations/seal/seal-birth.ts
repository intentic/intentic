import type { Seal } from "@intentic/sandbox-contract/schemas/seal";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { freshSeal, inheritedFrom, sealSourceOf } from "./seal-family.js";
import { houseOf, startsPrivate } from "../../auth/members/seal-house.js";

/* WHAT A NEW CONVERSATION IS BORN SEALED WITH. Inherited before anything else (a subagent, a review or a fork of a private
 * conversation carries its words, so it is private to the same people, whatever the request asked), which the registry
 * works out itself as the conversation opens (agents-registry.ts openedEntry). Otherwise a person's opening decides it at
 * the door: their home under any rule but `everyone`, else the composer's pill, else the house rule and their own
 * default. A program's or an automation's opening is born shared: it is the team's machinery, and its steward may make a
 * run private afterwards. */

/** The seal a conversation opening now inherits from the one it carries the words of, if that one is private. */
export const inheritedSeal = (
    turn: Pick<PersistedAgent["identity"], "startedBy" | "fresh" | "forkedFrom">,
    entryOf: (id: string) => Pick<PersistedAgent, "id" | "seal"> | undefined,
): Seal | undefined => {
    const sourceId = sealSourceOf(turn);
    const source = sourceId === undefined ? undefined : entryOf(sourceId);
    if (source?.seal === undefined) {
        return undefined;
    }
    return inheritedFrom(source.seal.from ?? source.id, source.seal);
};

/** A person's opening turn, with the seal it is born with when it is born private. Nothing for a conversation that exists. */
export const withOpeningSeal = async <T extends object>(
    services: Pick<Services, "agents" | "sealHouse" | "orgPolicy">,
    context: OrpcContext,
    conversationId: string,
    opening: T & { readonly home?: true },
    asked: boolean | undefined,
): Promise<T & { readonly seal?: Seal }> => {
    const caller = context.identity;
    if (caller === undefined || services.agents.entry(conversationId) !== undefined) {
        return opening;
    }
    const held = await services.sealHouse.read();
    const { mode } = houseOf(held, await services.orgPolicy.current());
    if (mode === "everyone") {
        return opening;
    }
    const sealed = opening.home === true || (asked ?? startsPrivate(mode, held, caller.email));
    return sealed ? { ...opening, seal: freshSeal({ email: caller.email, ...opt("name", caller.name) }, [], Date.now()) } : opening;
};
