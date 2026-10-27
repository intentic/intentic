import { TURN_CHECKS_SOURCE } from "@intentic/sandbox-contract/events/agent-ui";
import type { IconName } from "@intentic/ui";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

/* HOW A NOTICE ROW LOOKS: its glyph, and the colour a runtime's own notice is drawn in (ChatMessageView's meta row). */

// A notice the runtime's own extension or loop said (sandbox-contract events/agent-ui.ts): its level's glyph and colour.
// An info line stays the muted notice every other row is; only a warning or an error is drawn louder.
const AGENT_NOTICE_LOOK = {
    info: { icon: `info-circle`, tone: `text-subtle` },
    warning: { icon: `exclamation-triangle`, tone: `text-warning` },
    error: { icon: `exclamation-circle`, tone: `text-danger` },
} as const;

export const agentNoticeLookOf = (message: ChatMessage): (typeof AGENT_NOTICE_LOOK)[keyof typeof AGENT_NOTICE_LOOK] | undefined =>
    message.agentNotice === undefined ? undefined : AGENT_NOTICE_LOOK[message.agentNotice.level];

/** A home conversation going on in a fresh session (sandbox-notice.ts `freshStart`): drawn across the column as a
 *  divider (NoticeFreshStart), not as one more line down its edge, since the model's memory starts over there. */
export const isFreshStart = (message: ChatMessage): boolean => message.role === `notice` && message.noticeCode?.code === `freshStart`;

/** The repositories' end-of-turn checks said back to the agent: their own glyph, a line that names itself, and the
 *  findings the agent was told one press away. */
export const isTurnChecks = (message: ChatMessage): boolean => message.agentNotice?.source === TURN_CHECKS_SOURCE;

/** The row's glyph: the end-of-turn checks', a runtime notice's level, a failure, the board's own watch glyph, an
 *  answered need, another conversation, or a child reporting back. */
export const noticeIconOf = (message: ChatMessage, failed: boolean): IconName => {
    if (isTurnChecks(message)) {
        return `list-check`;
    }
    const look = agentNoticeLookOf(message);
    if (look !== undefined) {
        return look.icon;
    }
    if (failed) {
        return `exclamation-triangle`;
    }
    if (message.watchWake !== undefined) {
        return `eye`;
    }
    // An answered need: the same glyph as its card, so the two read as one thread.
    if (message.needWake !== undefined) {
        return message.needWake.outcome === `met` ? `check-circle` : `times`;
    }
    if (message.agentWords !== undefined) {
        return message.agentWords.kind === `peer` ? `comments` : `users`;
    }
    return `info-circle`;
};
