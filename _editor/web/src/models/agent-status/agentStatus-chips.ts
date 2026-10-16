import type { Tip } from "@intentic/ui";
import { formatWhen } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { toneWash } from "@intentic/ui/tone";
import { attentionReason } from "./agentStatus-attention";
import { laneOf } from "./agentStatus-lanes";
import { agentDisplayTitle } from "./agentStatus-meta";
import { type AgentStanding, limited, limitMoveBooked, limitScheduled, soonestHold, turnInFlight, watching } from "./agentStatus-standing";

// One bit, "this session isn't done yet", for surfaces that name an agent by its output rather than itself (the
// Changes panel's From legend). `laneOf` narrowed to a boolean rather than its own status list, so "finished" means
// the same thing here as on the board. A static dot, not the running spinner or a per-status icon: this is a
// filter control, and a chip per landed session would make the legend the busiest thing on the panel. `undefined`
// means the agent left the roster (archived or retired), which counts as finished.
export const unfinishedMark = (agent: AgentStanding | undefined): { dot: string; label: string } | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    const lane = laneOf(agent);
    if (lane === `finished`) {
        return undefined;
    }
    return lane === `active`
        ? { dot: `bg-link ring-2 ring-link/30`, label: activeLabel(agent) }
        : /* Named by the same reason the board's chip wears — including the bare `awaiting` this used to name
           * for itself. That fallback was the only place in the app that said something for a turn parked with
           * no flag raised, which is why it read as this mark's own quirk rather than as the hole it was; it
           * belongs to `attentionReason`, where every surface gets it. Kept here as a runtime floor for the
           * same reason STATUS_META keeps its `??`: a lane is decided by a status off an untyped wire, so a
           * build one version behind can be handed a standing it has no word for, and a chip reading
           * `undefined` in a legend is worse than one reading the plainest true thing. */
          { dot: `bg-primary-500`, label: attentionReason(agent) ?? t(`agents.agentStatus.waitingOn`) };
};

// "Working" would be wrong for the three Active cards that aren't: one is waiting on the world, one on a spent
// allowance's reset, one is being carried to another account. All restart themselves, so the label says which kind of
// unfinished rather than claiming work.
const activeLabel = (agent: AgentStanding): string => {
    // A booked move names its destination.
    const moving = limitMoveBooked(agent) ? agent.limitMoving : undefined;
    if (moving !== undefined) {
        return t(`agents.agentStatus.movingTo`, { account: moving });
    }
    if (limitScheduled(agent)) {
        return t(`agents.agentCard.resendBooked`);
    }
    return watching(agent) && !turnInFlight(agent) ? t(`agents.agentStatus.waitingOnCondition`) : t(`agents.agentStatus.stillWorking`);
};

// "New" (never opened) vs. "Updated" (opened, then worked on since); the marker lives on the daemon entry so
// opening it anywhere clears it everywhere. `seenAt` is returned raw for the caller to format; this module owns no
// clock.
const unreadBadge = (agent: { unread: boolean; seenAt?: number }): { label: string; seenAt?: number } | undefined =>
    !agent.unread
        ? undefined
        : agent.seenAt === undefined
          ? { label: t(`agents.words.new`) }
          : { label: t(`agents.agentStatus.updated`), seenAt: agent.seenAt };

// A CARD'S CORNER IS A WORD, NOT A GLYPH, AND THE SAME WORD EVERYWHERE. "Usage limit" and "Stopped" are what the
// reader needs; a triangle in the corner names neither, and the rail and the board each used to decide the word, the
// tint and the seat for themselves. This decides all three once: what it says, how it is tinted, and (by returning
// nothing) when the resting status glyph may have the corner back.
export interface StandingChip {
    readonly label: string;
    // Tailwind fill + ink for `ui-status-pill`. An ink tint, not a surface token: a surface token collides with the
    // selected card's lifted fill and, in the light scheme, with the card fill itself.
    readonly tone: string;
    // When the reader last opened it, raw, for a host with a clock to phrase; absent on every reason chip.
    readonly seenAt?: number;
    // What the one word stands for, where it stands for more than itself: when a scheduled card's messages go.
    readonly hint?: Tip;
}

// Muted for a spent allowance: it needs a person, but nothing is wrong and nothing is lost.
const LIMIT_TONE = `bg-content/10 text-muted`;
const REASON_TONE = toneWash(`warning`);
const UNREAD_TONE = `bg-primary-600/15 text-link`;

export const standingChip = (
    agent: AgentStanding & { readonly unread: boolean; readonly seenAt?: number },
    titleOf?: (conversationId: string) => string | undefined,
): StandingChip | undefined => {
    const reason = attentionReason(agent);
    if (reason !== undefined) {
        return { label: reason, tone: limited(agent) ? LIMIT_TONE : REASON_TONE };
    }
    // When it goes by itself outranks news: it is what a card that looks idle is waiting for. One word in the corner,
    // which a title shares the row with; when it goes is the word's hover.
    const scheduled = scheduledWhen(agent, titleOf);
    if (scheduled !== undefined) {
        return {
            label: t(`chat.chatHeld.scheduled`),
            tone: LIMIT_TONE,
            hint: { title: t(`chat.chatHeld.scheduled`), rows: [{ label: t(`chat.composerIntent.sendsAt`), value: scheduled }] },
        };
    }
    // Never both at once: "needs you" outranks "there is news".
    const badge = unreadBadge(agent);
    if (badge === undefined) {
        return undefined;
    }
    return { label: badge.label, tone: UNREAD_TONE, ...(badge.seenAt === undefined ? {} : { seenAt: badge.seenAt }) };
};

// When a conversation's booked messages go, as its card's corner says on hover: "Tue 09:00", or "After <agent> lands"
// for work waiting on another agent's land, that agent named by its card when one does (`titleOf`). Undefined for a
// conversation nothing is booked on.
export const scheduledWhen = (agent: Pick<AgentStanding, "queue">, titleOf?: (conversationId: string) => string | undefined): string | undefined => {
    const hold = soonestHold(agent.queue);
    if (hold === undefined) {
        return undefined;
    }
    if (hold.after !== undefined) {
        return t(`chat.sendLater.afterLands`, { title: titleOf?.(hold.after) ?? t(`chat.sendLater.anotherAgent`) });
    }
    return hold.until === undefined ? t(`chat.chatHeld.sendsShortly`) : formatWhen(hold.until);
};

// Children a family chip's hover names before counting the rest.
const CALLS_NAMED = 3;

// The corner a card wears for the children calling the reader through it (callsOwner): the one child's own word, or how
// many call, tinted as an ask (a spent allowance's muted tint when that is all they stopped on); its hover names them,
// one row each: what stopped it, and which child it is.
// The card's own reason outranks it, since that is the ask the card's own presses answer (AgentCard), and it outranks
// the card's unread mark, as any reason does.
export type FamilyChip = StandingChip & { readonly hint: Tip };
export const familyChip = (calls: readonly (AgentStanding & { readonly title?: string })[]): FamilyChip | undefined => {
    const first = calls[0];
    if (first === undefined) {
        return undefined;
    }
    const why = (child: AgentStanding): string => attentionReason(child) ?? t(`shared.needs`);
    const rest = calls.length - CALLS_NAMED;
    return {
        label: calls.length === 1 ? why(first) : t(`agents.childRows.needYou`, { count: calls.length }, calls.length),
        tone: calls.every(limited) ? LIMIT_TONE : REASON_TONE,
        hint: {
            title: t(`agents.words.childAgents`),
            rows: calls.slice(0, CALLS_NAMED).map((child) => ({ label: why(child), value: agentDisplayTitle(child) })),
            note: rest > 0 ? t(`agents.childRows.callsMore`, { count: rest }) : undefined,
        },
    };
};
