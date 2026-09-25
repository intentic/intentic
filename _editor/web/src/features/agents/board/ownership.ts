import { sandboxRef } from "@intentic/extension-api";
import type { SessionOwner } from "@intentic/sandbox-contract";
import { identityHue } from "../../../lib/identityHue";

// Whose a conversation is, as the board draws and filters it. Pure over the summary's `owner` and `startedBy`, so the
// card's mark, the header's chips and the menu's offers cannot disagree about the same card.

// A member on the presence roster, the one place a name is known for somebody who was assigned by address.
export interface KnownMember {
    readonly email: string;
    readonly name?: string;
}

export interface OwnerLook {
    readonly email: string;
    readonly name: string;
    // What fits a card's meta line and a header chip: the given name, never the whole address.
    readonly short: string;
    // The person's accent on the board header chip that filters to them.
    readonly hue: number;
    // The reader's own. Cards draw nothing for it: a mark on nearly every card tells no two cards apart.
    readonly mine: boolean;
}

export const sameAddress = (left: string, right: string | undefined): boolean => right !== undefined && left.toLowerCase() === right.toLowerCase();

// A name for a row with no room for a full one: the first word of a recorded name, or the local part of an address
// when no name was ever recorded.
const shortNameOf = (name: string): string => {
    const at = name.indexOf(`@`);
    const local = at > 0 ? name.slice(0, at) : name;
    return local.split(/\s+/).find((word) => word !== ``) ?? name;
};

// The owner as a person to draw: the recorded name, else what presence knows, else the address. Takes the address
// and a name rather than the whole record, so a chip can be drawn for somebody the board only knows by address.
export const ownerLook = (owner: { readonly email: string; readonly name?: string | undefined }, me: string | undefined, roster: readonly KnownMember[]): OwnerLook => {
    const known = roster.find((member) => sameAddress(owner.email, member.email));
    const name = owner.name ?? known?.name ?? owner.email;
    return { email: owner.email, name, short: shortNameOf(name), hue: identityHue(owner.email), mine: sameAddress(owner.email, me) };
};

// A starter that is not a person: a program holding a control token, or the conversation that spawned this one.
export type StarterLook = { readonly kind: "token"; readonly label: string } | { readonly kind: "child"; readonly parent: string };

const TOKEN_PREFIX = `token:`;
const CHILD_PREFIX = `agent:`;

export const starterLook = (startedBy: string | undefined): StarterLook | undefined => {
    if (startedBy?.startsWith(TOKEN_PREFIX) === true) {
        return { kind: `token`, label: startedBy.slice(TOKEN_PREFIX.length) };
    }
    if (startedBy?.startsWith(CHILD_PREFIX) === true) {
        return { kind: `child`, parent: startedBy.slice(CHILD_PREFIX.length) };
    }
    return undefined;
};

// What a card says about whose it is, decided in one place so the mark and the line it rides agree on whether there
// is anything to draw. The reader's own says nothing at all; somebody else's is a person; an unowned one is whatever
// program or parent started it.
export type SessionMark = { readonly kind: "person"; readonly look: OwnerLook } | StarterLook;

export const sessionMark = (
    agent: { readonly owner?: SessionOwner | undefined; readonly startedBy?: string | undefined },
    me: string | undefined,
    roster: readonly KnownMember[],
): SessionMark | undefined => {
    if (agent.owner !== undefined) {
        const look = ownerLook(agent.owner, me, roster);
        return look.mine ? undefined : { kind: `person`, look };
    }
    return starterLook(agent.startedBy);
};

export const ownedBy = (agent: { readonly owner?: SessionOwner | undefined }, email: string | undefined): boolean =>
    agent.owner !== undefined && sameAddress(agent.owner.email, email);

// Mirrors the daemon's verdict (conversations/ownership.ts) for what to offer; the route decides for real.
export const mayAssign = (owner: SessionOwner | undefined, me: string | undefined, canShip: boolean): boolean =>
    owner === undefined || sameAddress(owner.email, me) || canShip;

// The board's owner filter: one address, the reader's own for Mine, `undefined` for everybody's. Module-level so the
// choice survives leaving and returning to the board within one page; per sandbox, since the address can name a member
// of this board only; deliberately not persisted, since it hides other people's work.
export const ownerFilter = sandboxRef<string | undefined>(() => undefined);

// Everyone but the reader holding a conversation on this board: one chip each in the header, plus whoever `chosen`
// names even after their last card has left it, since a filter that named somebody must keep naming them or the row
// loses its lit segment and the way back. Sorted by name rather than by how much they hold, so a chip keeps its seat
// while the work under it moves.
export const boardOwners = (
    agents: readonly { readonly owner?: SessionOwner | undefined }[],
    me: string | undefined,
    roster: readonly KnownMember[],
    chosen?: string,
): readonly OwnerLook[] => {
    const byAddress = new Map<string, OwnerLook>();
    const add = (owner: { readonly email: string; readonly name?: string | undefined }): void => {
        const key = owner.email.toLowerCase();
        if (!sameAddress(owner.email, me) && !byAddress.has(key)) {
            byAddress.set(key, ownerLook(owner, me, roster));
        }
    };
    for (const agent of agents) {
        if (agent.owner !== undefined) {
            add(agent.owner);
        }
    }
    if (chosen !== undefined) {
        add({ email: chosen });
    }
    return [...byAddress.values()].toSorted((left, right) => left.name.localeCompare(right.name));
};
