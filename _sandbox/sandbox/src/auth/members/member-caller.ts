import { memberAccess, tierOf } from "@intentic/sandbox-contract/schemas/members";
import type { Caller, Member, MembersStore } from "../auth.js";

// Compare emails case-insensitively because roster writes normalize them.
const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * What a roster row admits its person as, apart from how they proved who they are: the one reading behind every
 * request's caller (authorize) and behind whose devices may hear of a conversation (push/push.ts).
 * A maintainer holds the owner's operating authority and reads every credential, so a fence over the tier would
 * enforce nothing (areas/invariant.ts `no-maintainer-is-fenced`), and the grant route refuses one. A row that carries
 * areas anyway, hand-edited or written before that refusal, used to hide most of the tree and every conversation
 * outside them from that person all the same: it is read as the whole workspace instead (`memberAccess` answers a
 * maintainer with no fence). The tier is the one the access makes, never the row's own word for it: every floor reads it.
 */
export const memberCaller = (member: Member): Caller => {
    const access = memberAccess(member);
    const areas = access.see === undefined ? {} : { areas: access.see };
    const assistants = member.assistants === undefined ? {} : { assistants: member.assistants };
    const manages = access.manages === undefined ? {} : { manages: access.manages };
    const caller: Caller = { email: member.email, role: tierOf(access), agents: access.agents, edits: access.edit, ...areas, ...assistants, ...manages };
    return access.lands === true ? { ...caller, lands: true } : caller;
};

/** The person behind an address as the roster admits them now: the bound owner, a member's row, or nobody. */
const rosterCaller = (owner: string | undefined, members: readonly Member[], email: string): Caller | undefined => {
    if (owner !== undefined && sameEmail(owner, email)) {
        return { email: owner, role: "owner" };
    }
    const member = members.find((row) => sameEmail(row.email, email));
    return member === undefined ? undefined : memberCaller(member);
};

/**
 * Reads the roster as it stands at each call, for whoever must know who a person is at the moment they act on it (the
 * push sender, per send): a removal or a new fence takes at once. Reads the services per call, since it is composed into
 * the very object it reads.
 */
export const rosterReader =
    (services: () => { readonly ownerEmail: () => Promise<string | undefined>; readonly members: Pick<MembersStore, "list"> }) =>
    async (): Promise<{ readonly callerOf: (email: string) => Caller | undefined }> => {
        const [owner, members] = await Promise.all([services().ownerEmail(), services().members.list()]);
        return { callerOf: (email) => rosterCaller(owner, members, email) };
    };
