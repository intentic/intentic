import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { provesOwner } from "../../seams/workload-stamp.js";
import type { Caller } from "../auth.js";
import { type ConversationReader, conversationReader, registryProvenance } from "./conversation-reader.js";

/* WHAT A TURN MAY READ OF THE FLEET (2026-11-04). An agent's CLIs (`agents show`, `agents find`, its children's reports)
 * reach the daemon with the per-boot agent token, which names no person, and such a caller used to read as the owner's own
 * tool: every conversation, a home and a private one included, whoever had started the turn asking. Now a turn reads as
 * the people it acts for, and only when it proves which turn it is (seams/workload-stamp.ts provesOwner): what every one
 * of its people may read (auth/fleet-scope.ts visibleTo), its own conversation always. A call with no proof, or one from
 * a conversation acting for nobody on the roster, reads only what is neither somebody's home nor private.
 * A person's own request (a bearer, `identity` set) reads as that person, as it always did. */

// Nobody in particular: reads a conversation only where no rule narrows it, so never a home but one's own (none) and never a private one.
const NOBODY: Caller = { email: "", role: "collaborator" };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// The people a conversation acts for, as callers the roster makes of them now; someone off the roster is nobody.
const chainOf = async (services: Pick<Services, "agents" | "members" | "ownerEmail">, conversationId: string): Promise<Caller[]> => {
    const entry = services.agents.entry(conversationId);
    if (entry === undefined) {
        return [NOBODY];
    }
    const owner = await services.ownerEmail();
    const people = entry.identity.people ?? (entry.social.owner === undefined ? [] : [entry.social.owner.email]);
    // Unattended work with nobody in it acts for the sandbox's owner (docs/architecture/access.md, Services).
    const named = people.length === 0 && owner !== undefined ? [owner] : people;
    const members = await services.members.list();
    return named.map((email): Caller => {
        if (owner !== undefined && same(email, owner)) {
            return { email, role: "owner" };
        }
        const member = members.find((held) => same(held.email, email));
        return member === undefined ? NOBODY : { email, role: member.role, ...(member.areas === undefined ? {} : { areas: member.areas }) };
    });
};

/** The reader for a fleet read: the person behind a bearer, else the proven turn's people, else nobody. */
export const turnReader = async (services: Pick<Services, "agents" | "members" | "ownerEmail">, c: Context<AppEnv>): Promise<ConversationReader> => {
    const provenance = registryProvenance(services.agents);
    const identity = c.get("identity");
    if (identity !== undefined) {
        return conversationReader(identity, provenance);
    }
    const named = c.req.header("x-intentic-conversation");
    if (named === undefined || named === "" || !provesOwner(named, c.req.header("x-intentic-turn-proof"))) {
        return conversationReader(NOBODY, provenance);
    }
    const readers = (await chainOf(services, named)).map((caller) => conversationReader(caller, provenance));
    return (conversationId) => conversationId === named || readers.every((reads) => reads(conversationId));
};
