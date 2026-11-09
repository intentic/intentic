import type { SessionOwner } from "@intentic/sandbox-contract/schemas/agents";
import { computed, shallowRef } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import { type KnownMember, ownerLook, type OwnerLook } from "../../agent-status/ownership";
import { otherBoxes } from "../../sandbox/live/fleetAcross";
import { useAgents } from "../useAgents";

// A press that decides what becomes of somebody else's work asks first. The cards of two people sit side by side on one
// board with only a name on the meta line to tell them apart, so the wrong card is an easy press and its owner finds out
// from their files. One question for every surface that makes such a press by hand, asked BEFORE the press claims its
// card or writes anything, so declining leaves no trace. What the daemon does by itself never comes here.

// The presses that ask:
// - `land`: the work goes into the tree everyone shares, now
// - `discard`: the branch and everything on it that never landed is deleted, for good
// - `autoLand`: every turn it finishes from here on lands with nobody reviewing it, a land agreed to in advance
export type ForeignPress = `land` | `discard` | `autoLand`;

// What the question names: whose it is, and which conversation, read off the card as it was pressed.
export interface ForeignAsk {
    readonly kind: ForeignPress;
    readonly id: string;
    readonly at: string | undefined;
    readonly owner: OwnerLook;
    readonly title: string | undefined;
    readonly files: number | undefined;
}

interface OwnedCard {
    readonly owner?: SessionOwner | undefined;
    readonly title?: string | undefined;
    readonly diff?: { readonly files: number } | undefined;
}

// Whose the card is when that is somebody other than the reader. Nothing for the reader's own, for one nobody owns (a
// program started it: there is no person to surprise), and for a reader with no address to compare (a sandbox nobody
// signs in to has one driver).
export const foreignOwner = (card: OwnedCard | undefined, me: string | undefined, roster: readonly KnownMember[]): OwnerLook | undefined => {
    if (card?.owner === undefined || me === undefined) {
        return undefined;
    }
    const look = ownerLook(card.owner, me, roster);
    return look.mine ? undefined : look;
};

// How many of a set of cards are other people's, and whose, each person once and by name.
export interface ForeignShare {
    readonly count: number;
    readonly owners: readonly OwnerLook[];
}

/** What a press on many cards at once has to say about whose they are. */
export const foreignShare = (cards: readonly OwnedCard[], me: string | undefined, roster: readonly KnownMember[]): ForeignShare => {
    const byAddress = new Map<string, OwnerLook>();
    let count = 0;
    for (const card of cards) {
        const owner = foreignOwner(card, me, roster);
        if (owner !== undefined) {
            count += 1;
            byAddress.set(owner.email.toLowerCase(), owner);
        }
    }
    return { count, owners: [...byAddress.values()].toSorted((left, right) => left.name.localeCompare(right.name)) };
};

const cardOf = (id: string, at: string | undefined): OwnedCard | undefined =>
    at === undefined ? useAgents().agentById(id) : otherBoxes.value.find((box) => box.sandbox.id === at)?.agents.find((agent) => agent.id === id);

/**
 * Whether a press on this card has a question to ask first. Answered at once, so a press on the reader's own
 * conversation runs in the tick it was pressed in (its claim on the card is what refuses a second press) and only
 * somebody else's waits on `cleared`. Also how a surface with a confirm of its own knows to stand down for this one.
 */
export const asksFirst = (id: string, at: string | undefined): boolean =>
    foreignOwner(cardOf(id, at), useAuth().user.value?.email, presenceOthers.value) !== undefined;

// One question at a time, app-wide: the dialog is the app's (ForeignPressConfirm, mounted once), not a surface's.
const pending = shallowRef<{ readonly ask: ForeignAsk; readonly settle: (go: boolean) => void } | undefined>(undefined);

export const foreignAsk = computed(() => pending.value?.ask);

export const answerForeign = (go: boolean): void => {
    const asked = pending.value;
    pending.value = undefined;
    asked?.settle(go);
};

/**
 * Whether the press may go: at once for the reader's own conversation, and for somebody else's once the reader has
 * said so. A second press while the question is up replaces it, the first answered no.
 */
export const cleared = (kind: ForeignPress, id: string, at: string | undefined): Promise<boolean> => {
    const card = cardOf(id, at);
    const owner = foreignOwner(card, useAuth().user.value?.email, presenceOthers.value);
    if (owner === undefined) {
        return Promise.resolve(true);
    }
    answerForeign(false);
    return new Promise((settle) => {
        pending.value = { ask: { kind, id, at, owner, title: card?.title, files: card?.diff?.files }, settle };
    });
};
