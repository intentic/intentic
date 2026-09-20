import { type MemberRole, roleAtLeast, type SessionOwner } from "@intentic/sandbox-contract";
import { slicesCover } from "../auth/fleet-scope.js";

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

// Whether the work may change hands to this member at all: the slices it was born with must be among the ones they
// hold. Assignment is the one route that can hand a conversation to someone who could not have started it, so
// without this it is the way around every other narrowing — a fenced member cannot read `finance/`, but an unfenced
// colleague's conversation about it, handed over, is that folder in prose.
// Narrowing is always allowed: a conversation keeps its own fence when it moves, so handing it to someone who holds
// more changes nothing about what it may touch.
export const fenceVerdict = (work: readonly string[] | undefined, holder: readonly string[] | undefined, to: string): AssignVerdict =>
    slicesCover(holder, work)
        ? { kind: "ok" }
        : {
              kind: "forbidden",
              message: `this conversation works in parts of the workspace ${to} does not have access to; widen their access first, or hand it to somebody who has it`,
          };

// An owner must be someone who can sign in here: the sandbox owner or a listed member. Addresses compare folded, as
// the members file stores them.
export const isMemberAddress = (address: string, ownerEmail: string | undefined, members: readonly { readonly email: string }[]): boolean => {
    const wanted = address.toLowerCase();
    return ownerEmail?.toLowerCase() === wanted || members.some((member) => member.email.toLowerCase() === wanted);
};
