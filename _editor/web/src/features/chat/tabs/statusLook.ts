import type { IconName } from "@intentic/ui";
import { agentStatusMeta, cornerInk, cornerStandingShown } from "../../../models/agent-status/agentStatus-meta";
import type { AgentStanding } from "../../../models/agent-status/agentStatus-standing";
import type { Conversation } from "../../../models/conversations/session/conversation";
import { statusIcon, statusLabel, statusTabClass } from "../models/catalog";

// WHAT A CHAT IS DOING, AS ITS GLYPH SAYS IT: read off the board's card for it whenever there is one, and off the
// conversation's own status (a window's reading of its own refs) only where there is none: another box's chat, or a
// fleet not joined yet. The rail's corner and the chat's header (its bar, the phone's header, the switcher sheet) draw
// from this one reading, so they cannot say different things about one chat. The header once read the window's own
// status alone, which a reload resets (the board said error while the chat above said idle) and which has no word for a
// turn this window did not start, nor for resuming, landing or interrupted.

export interface StatusLook {
    readonly name: IconName;
    readonly spin?: boolean;
    readonly label: string;
    // The glyph in the chat's header and switcher, where a dot is drawn smaller than a glyph (statusIcon's rule).
    readonly header: string;
    // The same glyph in a rail card's corner, in the corner's quiet ink (cornerInk).
    readonly corner: string;
    // The title's ink beside the header's glyph: working, waiting on you, failed; none for a standing asking nothing.
    readonly title: string;
    // Whether a card's corner draws it at all: not for a card that never started (cornerStandingShown).
    readonly cornered: boolean;
}

// The card's standing in the header's title ink, in the words the conversation's own status has for it.
const titleOf = (status: AgentStanding[`status`], spin: boolean): string =>
    statusTabClass(spin ? `streaming` : status === `awaiting` || status === `error` ? status : `idle`);

const cardLook = ({ status }: Pick<AgentStanding, "status">): StatusLook => {
    const meta = agentStatusMeta(status);
    return {
        name: meta.icon,
        spin: meta.spin,
        label: meta.label,
        header: `${meta.icon === `circle-fill` ? `text-[0.5rem]` : `text-2xs`} ${meta.class}`,
        corner: `text-xs ${cornerInk(meta.class)}`,
        title: titleOf(status, meta.spin === true),
        cornered: cornerStandingShown(status),
    };
};

const ownLook = (conversation: Pick<Conversation, "status">): StatusLook => {
    const status = conversation.status.value;
    const icon = statusIcon(status);
    return {
        name: icon.name,
        spin: icon.spin,
        label: statusLabel(status),
        header: icon.class,
        corner: `text-xs ${cornerInk(icon.class)}`,
        title: statusTabClass(status),
        cornered: true,
    };
};

/** A chat's status glyph: its card's when it has one (the same lookup the rail's rows use), else its own. */
export const statusLookOf = (conversation: Pick<Conversation, "status">, card: Pick<AgentStanding, "status"> | undefined): StatusLook =>
    card === undefined ? ownLook(conversation) : cardLook(card);

/** The look bound straight onto the header's Icon. */
export const headerGlyph = (look: StatusLook) => ({ name: look.name, spin: look.spin, class: look.header });
