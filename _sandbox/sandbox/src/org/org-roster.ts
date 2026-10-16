import { type AuditEvent, type OrgPolicy, orgPersonPreimage } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import type { MembersStore } from "../auth/auth.js";
import type { OrgPolicyHolder } from "./org-policy.js";

/* AN ORGANISATION'S MEMBER LIST AS THE OUTER FENCE OF A BOUND SANDBOX'S ROSTER (schemas/organisation.ts `membersOnly`;
 * docs/architecture/organisations.md, "Leavers"). The roster (auth.ts, history/identity/members.json) stays the copy
 * that is enforced; the organisation narrows it, two ways:
 *   - every read of the roster leaves out a person the organisation does not list (`fencedMembers`), so a sign-in, a
 *     session or a token of theirs is refused at once, at every door that asks the roster, and a row written into the
 *     file by hand is no way back in;
 *   - each policy that arrives takes such people off the file and closes what their browsers still hold
 *     (`reconcileOrgRoster`), so a person removed from the organisation is removed here without anyone in the sandbox
 *     acting, and without their cooperation.
 * The sandbox's owner is not on the roster, so neither reaches them: an owner leaving is the ownership handover the
 * organisation does not have yet. A policy without `membersOnly`, or one that sends no `people`, fences nothing. */

export const orgPersonDigest = (orgId: string, email: string): string => sha256Hex(orgPersonPreimage(orgId, email));

// Whether the policy lets this address onto the roster: always, unless it keeps the roster to the organisation's people.
export const orgAdmits = (policy: OrgPolicy | undefined, email: string): boolean =>
    policy?.membersOnly !== true || policy.people === undefined || policy.people.includes(orgPersonDigest(policy.orgId, email));

// The roster as everything in the daemon reads it, narrowed to the people the organisation lists. Writes pass through:
// the grant route refuses a person the organisation does not list before it gets here (members.routes.ts).
export const fencedMembers = (store: MembersStore, holder: Pick<OrgPolicyHolder, "current">): MembersStore => ({
    list: async () => {
        const [members, policy] = await Promise.all([store.list(), holder.current()]);
        return members.filter((member) => orgAdmits(policy, member.email));
    },
    add: (email, grant) => store.add(email, grant),
    remove: (email) => store.remove(email),
});

// Takes everyone the policy does not admit off the roster file and closes what they hold. `members` is the UNFENCED
// store: the fenced one no longer lists the people this is for.
export const reconcileOrgRoster = async (
    deps: {
        readonly members: MembersStore;
        readonly revoke: (email: string) => void;
        readonly record: (event: AuditEvent) => void;
        readonly logger: Pick<Logger, "info">;
    },
    policy: OrgPolicy | undefined,
): Promise<readonly string[]> => {
    if (policy?.membersOnly !== true || policy.people === undefined) {
        return [];
    }
    const leaving = (await deps.members.list()).filter((member) => !orgAdmits(policy, member.email)).map((member) => member.email);
    for (const email of leaving) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one roster file, one write at a time through its own queue
        await deps.members.remove(email);
        deps.revoke(email);
        deps.record({
            actor: { kind: "system", reason: "organisation policy" },
            action: "member.revoke",
            target: email,
            details: { org: policy.orgName, reason: "not a member of the organisation" },
        });
    }
    if (leaving.length > 0) {
        deps.logger.info({ org: policy.orgId, removed: leaving.length }, "org policy: took people the organisation no longer lists off the roster");
    }
    return leaving;
};
