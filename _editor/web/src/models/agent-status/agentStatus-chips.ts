import type { Tip } from "@intentic/ui";
import { formatWhen } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { toneWash } from "@intentic/ui/tone";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { attentionReason, endingReason, landFailure } from "./agentStatus-attention";
import { failureGist, failureKind, failureTone, failureWord } from "./agentStatus-failure";
import { laneOf } from "./agentStatus-lanes";
import { agentDisplayTitle } from "./agentStatus-meta";
import { type AgentStanding, limited, memoryHeld, turnInFlight, watching } from "./agentStatus-standing";

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
    const next = agent.next;
    // A booked move names its destination.
    if (next?.kind === `rerun`) {
        return next.onto === undefined ? t(`agents.agentCard.resendBooked`) : t(`agents.agentStatus.movingTo`, { account: next.onto });
    }
    if (turnInFlight(agent)) {
        return t(`agents.agentStatus.stillWorking`);
    }
    if (watching(agent)) {
        return t(`agents.agentStatus.waitingOnCondition`);
    }
    // Nothing running and something set to go: scheduled, the word its corner wears, never "still working".
    return next === undefined ? t(`agents.agentStatus.stillWorking`) : t(`chat.chatHeld.scheduled`);
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
    // What the one word stands for, where it stands for more than itself: when a scheduled card's messages go, or the
    // words a failure the word names came with (cardFailure).
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
        // A word naming the failure the card ended on opens what it came with, the same card the body's line raises.
        const failure = cardFailure(agent);
        const chip = { label: reason, tone: limited(agent) ? LIMIT_TONE : REASON_TONE };
        return failure?.title === reason ? { ...chip, hint: failure.tip } : chip;
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
const scheduledWhen = (agent: Pick<AgentStanding, "next">, titleOf?: (conversationId: string) => string | undefined): string | undefined => {
    const next = agent.next;
    if (next?.kind === `land`) {
        return t(`chat.sendLater.afterLands`, { title: titleOf?.(next.after) ?? t(`chat.sendLater.anotherAgent`) });
    }
    return next?.kind === `send` ? formatWhen(next.at) : undefined;
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

// WHAT A CARD SAYS OF THE FAILURE IT ENDED ON. The corner already names the kind (attentionReason), so the body spends
// one line on the gist and keeps the rest for a hover: a red paragraph of the provider's English, clamped at two lines
// beside the corner's "Error", said the same thing twice and neither time what the reader could do. The line is the
// first sentence of the words the turn died on, in the card's own ink behind one tinted glyph; the hover is the kind
// over those words whole. A spent allowance and a memory hold draw none: nothing failed, and the corner and the clock say
// all there is.
export interface CardFailure {
    // The kind, in the corner's word: the hover's headline.
    readonly title: string;
    // The line at rest: the first sentence of what it failed with.
    readonly gist: string;
    // The glyph's ink and the hover's dot: a fault, or a refusal to decide about.
    readonly tone: `danger` | `warning`;
    // The hover: the kind, and the words whole.
    readonly tip: Tip;
}

const capitalised = (words: string): string => `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`;

export const cardFailure = (agent: AgentStanding): CardFailure | undefined => {
    // A land that broke, in the reader's words rather than git's (landFailure): the command it ran is no instruction to
    // them. The corner says it couldn't land unless an ask outranks that, and only then does the line say so too.
    const land = landFailure(agent);
    if (land !== undefined) {
        const title = useVocabulary().value.couldntLand;
        const gist = attentionReason(agent) === title ? capitalised(land) : t(`agents.agentStatus.couldntLand`, { reason: land });
        return { title, gist, tone: `danger`, tip: { title, tone: `danger`, quote: capitalised(land) } };
    }
    const words = agent.failure?.trim();
    if (words === undefined || words === `` || limited(agent) || memoryHeld(agent)) {
        return undefined;
    }
    const kind = failureKind(agent);
    const title = kind === undefined ? (endingReason(agent.status) ?? t(`agents.agentStatus.error`)) : failureWord(kind);
    const tone = failureTone(kind);
    return { title, gist: failureGist(words), tone, tip: { title, tone, quote: words } };
};
