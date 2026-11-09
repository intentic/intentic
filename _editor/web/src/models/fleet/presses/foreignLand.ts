import type { SessionOwner } from "@intentic/sandbox-contract/schemas/agents";
import { computed, shallowRef } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import { type KnownMember, ownerLook, type OwnerLook } from "../../agent-status/ownership";
import { otherBoxes } from "../../sandbox/live/fleetAcross";
import { useAgents } from "../useAgents";

// A land pressed on a conversation somebody else owns asks first. Landing puts the work into the tree everyone shares,
// and the cards of two people sit side by side on one board with only a name on the meta line to tell them apart, so
// the wrong card is an easy press and its owner finds out from their files. One question for every surface that lands
// by hand (the board's card and drop, the menus, the chat's strip, the review's header), asked BEFORE the press claims
// its card or commits anything, so declining leaves no trace. Automatic lands are the daemon's and never come here.

// What the question names: whose it is, and which conversation, read off the card as it was pressed.
export interface ForeignLandAsk {
    readonly id: string;
    readonly at: string | undefined;
    readonly owner: OwnerLook;
    readonly title: string | undefined;
    readonly files: number | undefined;
}

interface LandCard {
    readonly owner?: SessionOwner | undefined;
    readonly title?: string | undefined;
    readonly diff?: { readonly files: number } | undefined;
}

// Whose the card is when that is somebody other than the reader. Nothing for the reader's own, for one nobody owns (a
// program started it: there is no person to surprise), and for a reader with no address to compare (a sandbox nobody
// signs in to has one driver).
export const foreignOwner = (card: LandCard | undefined, me: string | undefined, roster: readonly KnownMember[]): OwnerLook | undefined => {
    if (card?.owner === undefined || me === undefined) {
        return undefined;
    }
    const look = ownerLook(card.owner, me, roster);
    return look.mine ? undefined : look;
};

const cardOf = (id: string, at: string | undefined): LandCard | undefined =>
    at === undefined ? useAgents().agentById(id) : otherBoxes.value.find((box) => box.sandbox.id === at)?.agents.find((agent) => agent.id === id);

/**
 * Whether a land of this card has a question to ask first. Answered at once, so a press on the reader's own
 * conversation runs in the tick it was pressed in (its claim on the card is what refuses a second press) and only
 * somebody else's waits on `clearedToLand`. Also how a surface with a confirm of its own knows to stand down for this one.
 */
export const asksBeforeLand = (id: string, at: string | undefined): boolean =>
    foreignOwner(cardOf(id, at), useAuth().user.value?.email, presenceOthers.value) !== undefined;

// One question at a time, app-wide: the dialog is the app's (ForeignLandConfirm, mounted once), not a surface's.
const pending = shallowRef<{ readonly ask: ForeignLandAsk; readonly settle: (go: boolean) => void } | undefined>(undefined);

export const foreignLandAsk = computed(() => pending.value?.ask);

export const answerForeignLand = (go: boolean): void => {
    const asked = pending.value;
    pending.value = undefined;
    asked?.settle(go);
};

/**
 * Whether a land pressed by hand may go: at once for the reader's own conversation, and for somebody else's once the
 * reader has said so. A second press while the question is up replaces it, the first answered no.
 */
export const clearedToLand = (id: string, at: string | undefined): Promise<boolean> => {
    const card = cardOf(id, at);
    const owner = foreignOwner(card, useAuth().user.value?.email, presenceOthers.value);
    if (owner === undefined) {
        return Promise.resolve(true);
    }
    answerForeignLand(false);
    return new Promise((settle) => {
        pending.value = { ask: { id, at, owner, title: card?.title, files: card?.diff?.files }, settle };
    });
};
