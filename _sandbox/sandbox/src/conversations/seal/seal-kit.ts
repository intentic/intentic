import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import type { Seal, SealHouse } from "@intentic/sandbox-contract/schemas/seal";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Caller } from "../../auth/auth.js";
import { framedSummary, listedTo, provenanceOf } from "../../auth/fleet-scope.js";
import { holdsSeal } from "../../auth/seal-scope.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { conversationUrl } from "../../push/notifications.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { freshSeal, sealRootOf, writeFamilySeal } from "./seal-family.js";
import { houseOf, startsPrivate } from "../../auth/members/seal-house.js";
import { sealedCount } from "./seal-jail.js";

/* What every private-conversation route leans on (seal.routes.ts): who is asking, the root a route acts on, the card it
 * answers with as the caller is shown it, the push that tells a person, and the audit line it leaves. */

export const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const personOf = (caller: Caller) => ({ email: caller.email.toLowerCase(), ...opt("name", caller.name) });

export const signedIn = (context: OrpcContext): Caller => {
    if (context.identity === undefined) {
        throw new ORPCError("FORBIDDEN", { message: "only a signed-in person may do this" });
    }
    return context.identity;
};

// Who answers for a conversation and so may change its seal: its owner, else (nobody claimed it) one of its readers.
export const mayChange = (caller: Caller, entry: PersistedAgent): boolean =>
    entry.social.owner === undefined ? entry.seal === undefined || holdsSeal(caller, entry.seal) : same(entry.social.owner.email, caller.email);

export const sealOf = (entry: PersistedAgent): Seal => {
    if (entry.seal === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "this conversation is not private" });
    }
    return entry.seal;
};

export type SealKit = ReturnType<typeof sealKit>;

// `replaceShells` is filled by the router (agent/run/placement/jail-placement.ts placePeopleShells), which sits above both.
export const sealKit = (services: Services, replaceShells: () => void) => {
    const bindingHouse = async () => {
        const held = await services.sealHouse.read();
        return { held, ...houseOf(held, await services.orgPolicy.current()) };
    };
    const houseFor = async (caller: Caller | undefined): Promise<SealHouse> => {
        const house = await bindingHouse();
        const own = caller === undefined ? undefined : house.held.defaults[caller.email.toLowerCase()];
        return {
            mode: house.mode,
            locked: house.locked,
            twoPerson: house.twoPerson,
            hosted: process.env["SANDBOX_VM"] === "1",
            sealed: sealedCount(services.agents),
            startsPrivate: house.mode !== "everyone" && startsPrivate(house.mode, house.held, caller?.email),
            ...opt("ownDefault", own),
        };
    };
    // The root a route acts on, refused unless the caller is shown its card.
    const rootFor = (id: string, caller: Caller): PersistedAgent => {
        const named = services.agents.entry(id);
        const root = named === undefined ? undefined : services.agents.entry(sealRootOf(named));
        if (root === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown conversation" });
        }
        if (!listedTo(caller, provenanceOf(root))) {
            throw new ORPCError("FORBIDDEN", { message: "not one of your conversations" });
        }
        return root;
    };
    const framed = (caller: Caller, summary: AgentSummary | undefined): AgentSummary => {
        const shown = summary === undefined ? undefined : framedSummary(caller, summary);
        if (shown === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown conversation" });
        }
        return shown;
    };
    const tell = async (to: string, title: string, conversationId: string, body: string): Promise<void> => {
        await services.pushSender.notifyIfAway({ title, body, url: conversationUrl(conversationId), tag: `seal-${conversationId}` }, to);
    };
    const record = (caller: Caller, action: string, target: string, details?: AuditEvent["details"]): void => {
        services.audit.record({ actor: { kind: "member", email: caller.email.toLowerCase(), role: caller.role }, action, target, ...opt("details", details) });
    };
    // Every home that is not private yet, made private to its own person: under any rule but `everyone` a home is one
    // person's chat with the sandbox, and the sandbox's owner reads it no more than anyone else does.
    const sealHomes = async (): Promise<void> => {
        const homes = [...services.agents.list(), ...services.agents.listArchived()].filter((summary) => summary.home === true && summary.seal === undefined);
        for (const home of homes) {
            const owner = services.agents.entry(home.id)?.social.owner;
            if (owner !== undefined) {
                await writeFamilySeal(services, home.id, freshSeal(owner, [], Date.now()));
            }
        }
    };
    return { services, bindingHouse, houseFor, rootFor, framed, tell, record, sealHomes, replaceShells };
};
