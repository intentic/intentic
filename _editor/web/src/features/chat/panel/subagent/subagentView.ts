import { shallowReactive, shallowRef } from "vue";
import { parentOf } from "../../../agents/board/ownership";
import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
import type { Conversation } from "../../session/conversation";

// WHICH SUBAGENT A CHAT IS SHOWING, when it shows one. A subagent its parent's runtime ran in-process has no chat of its
// own, so it is shown in its parent's: the parent's column steps into it (ChatSubagentPane) and steps back out, the way a
// card's tray row stands under that card. Held per window, as the panes are; one at a time, as a press on another row
// replaces it. It lasts only while the parent's column is on screen and the parent was not picked again: pressing the
// parent's card means "the parent", and a column the reader moved away from comes back as the parent's own chat.
//
// A subagent spawned as a conversation of its own needs none of this: its row opens its own chat (ChatPane), which
// knows it is a subagent from its card (`parentCardOf`).

export interface SubagentOnScreen {
    // The conversation whose turn ran it, and whose column it is shown in.
    readonly parentId: string;
    // Its own id: the id of the call that started it.
    readonly id: string;
}

// allow(module-state): per window, as the panes it rides are.
export const subagentOnScreen = shallowRef<SubagentOnScreen | undefined>();

export const showSubagent = (parentId: string, id: string): void => {
    const now = subagentOnScreen.value;
    if (now?.parentId !== parentId || now.id !== id) {
        subagentOnScreen.value = { parentId, id };
    }
};

/** Steps back to the parent: only this parent's column, when one is named, else whichever is showing a subagent. */
export const closeSubagent = (parentId?: string): void => {
    if (subagentOnScreen.value !== undefined && (parentId === undefined || subagentOnScreen.value.parentId === parentId)) {
        subagentOnScreen.value = undefined;
    }
};

/** Keeps the view only while its parent's column is drawn: a parent that left the screen comes back as itself. */
export const keepSubagentWhileShown = (drawn: readonly string[]): void => {
    const now = subagentOnScreen.value;
    if (now !== undefined && !drawn.includes(now.parentId)) {
        subagentOnScreen.value = undefined;
    }
};

/**
 * The card of the conversation that spawned this one, while it is on the fleet: what makes a spawned conversation a
 * subagent, whose chat is its parent's to direct. A parent archived or gone leaves the child a conversation in its own
 * right, as the board then stands it as a card of its own.
 */
export const parentCardOf = (agent: FleetAgent | undefined, cardOf: (id: string) => FleetAgent | undefined): FleetAgent | undefined => {
    const parentId = parentOf(agent?.startedBy);
    const parent = parentId === undefined ? undefined : cardOf(parentId);
    return parent === undefined || parent.archivedAt !== undefined || parent.sandboxId !== agent?.sandboxId ? undefined : parent;
};

// The spawned subagents the reader chose to write to directly ("Write to it" on the subagent bar), whose chats show the
// composer again. By conversation, for as long as this window holds it: a choice about this chat, not a setting.
// allow(module-state): per window, as the conversations it names are.
const writing = shallowReactive(new WeakSet<Conversation>());

export const writesTo = (conversation: Conversation): boolean => writing.has(conversation);

export const writeTo = (conversation: Conversation): void => {
    writing.add(conversation);
};
