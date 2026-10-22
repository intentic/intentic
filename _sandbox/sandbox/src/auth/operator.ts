import { landsHere, memberAccess } from "@intentic/sandbox-contract/schemas/members";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Caller } from "./auth.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

// Is the person behind this request one who may see a credential: maintainer-or-owner tier, same line as
// owner-gates.ts.
// A program never qualifies, whatever its scope, since a control token carries no member identity; loopback mode has no
// identities at all, so everyone there is the owner.
export const operatorHere = (services: Pick<Services, "auth">, context: Pick<OrpcContext, "identity">): boolean =>
    services.auth === undefined || (context.identity !== undefined && roleAtLeast(context.identity.role, "maintainer"));

/**
 * Whether work done for this verified member lands by itself, and so whether they may land it (sandbox-contract
 * `landsHere`): a maintainer's and the owner's everywhere, a home-only member's on their own home when granted. One
 * answer for the person and the agent that works for them, so neither ever holds an authority the other does not.
 */
export const callerLands = (caller: Pick<Caller, "role" | "agents" | "lands">): boolean =>
    landsHere({ manage: roleAtLeast(caller.role, "maintainer"), agents: caller.agents ?? "run", lands: caller.lands });

/** `callerLands` for a request: loopback mode holds the whole sandbox; a program (a control token) is no person. */
export const landsHereFor = (services: Pick<Services, "auth">, context: Pick<OrpcContext, "identity">): boolean =>
    services.auth === undefined || (context.identity !== undefined && callerLands(context.identity));

/**
 * Whether a home's work lands by itself now: its owner's current authority to land (`landsHere`), the sandbox's owner and
 * a loopback daemon holding all of it. Read at the land, not the opening, so taking a person's authority away holds their
 * home's next land rather than letting an answer latched long ago keep landing.
 */
export const homeOwnerLands = async (services: Pick<Services, "auth" | "members" | "ownerEmail">, owner: string | undefined): Promise<boolean> => {
    if (services.auth === undefined) {
        return true;
    }
    if (owner === undefined) {
        return false;
    }
    const email = owner.toLowerCase();
    if ((await services.ownerEmail())?.toLowerCase() === email) {
        return true;
    }
    const row = (await services.members.list()).find((member) => member.email.toLowerCase() === email);
    return row !== undefined && landsHere(memberAccess(row));
};
