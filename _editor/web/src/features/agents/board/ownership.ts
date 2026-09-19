import type { SessionOwner } from "@intentic/sandbox-contract";
import { ref } from "vue";

// Whose a conversation is, as the board draws and filters it. Pure over the summary's `owner` and `startedBy`, so the
// mark, the Mine toggle and the menu's offers cannot disagree about the same card.

// A member on the presence roster, the one place a name or picture is known for somebody who was assigned by address.
export interface KnownMember {
    readonly email: string;
    readonly name?: string;
    readonly picture?: string;
}

export interface OwnerLook {
    readonly email: string;
    readonly name: string;
    readonly picture?: string;
    // The reader's own; drawn as "you" rather than their name.
    readonly mine: boolean;
}

const same = (left: string, right: string | undefined): boolean => right !== undefined && left.toLowerCase() === right.toLowerCase();

// The owner as a person to draw: the recorded name, else what presence knows, else the address.
export const ownerLook = (owner: SessionOwner, me: string | undefined, roster: readonly KnownMember[]): OwnerLook => {
    const known = roster.find((member) => same(owner.email, member.email));
    return {
        email: owner.email,
        name: owner.name ?? known?.name ?? owner.email,
        ...(known?.picture === undefined ? {} : { picture: known.picture }),
        mine: same(owner.email, me),
    };
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

export const ownedBy = (agent: { readonly owner?: SessionOwner | undefined }, email: string | undefined): boolean =>
    agent.owner !== undefined && same(agent.owner.email, email);

// Mirrors the daemon's verdict (agents/ownership.ts) for what to offer; the route decides for real.
export const mayAssign = (owner: SessionOwner | undefined, me: string | undefined, canShip: boolean): boolean =>
    owner === undefined || same(owner.email, me) || canShip;

// The board's Mine toggle: only the reader's own sessions in every lane. Module-level so the choice survives leaving
// and returning to the board within one page; deliberately not persisted, since it hides other people's work.
export const mineOnly = ref(false);
