import { type MemberRole, roleAtLeast, type SessionOwner } from "@intentic/sandbox-contract";

// Who may make a member answerable for a conversation (agents.assign): its owner hands it over, a maintainer or the
// sandbox owner reassigns anyone's, and one nobody owns is claimable by anyone at the driving tier, which the route's
// floor already guarantees. Pure, so the three cases are pinned without a daemon.

export type AssignVerdict = { readonly kind: "ok" } | { readonly kind: "forbidden"; readonly message: string };

export const assignVerdict = (owner: SessionOwner | undefined, caller: { readonly email: string; readonly role: MemberRole }): AssignVerdict => {
    if (owner === undefined || owner.email.toLowerCase() === caller.email.toLowerCase() || roleAtLeast(caller.role, "maintainer")) {
        return { kind: "ok" };
    }
    return {
        kind: "forbidden",
        message: `this conversation is ${owner.name ?? owner.email}'s; ask them to hand it over, or a maintainer to reassign it`,
    };
};

// An owner must be someone who can sign in here: the sandbox owner or a listed member. Addresses compare folded, as
// the members file stores them.
export const isMemberAddress = (address: string, ownerEmail: string | undefined, members: readonly { readonly email: string }[]): boolean => {
    const wanted = address.toLowerCase();
    return ownerEmail?.toLowerCase() === wanted || members.some((member) => member.email.toLowerCase() === wanted);
};
