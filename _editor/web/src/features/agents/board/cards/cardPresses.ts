import type { ActionItem, Tip, TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { changesToRead } from "../../../../models/agent-status/agentStatus-attention";
import { bookedGroups } from "../../../../models/conversations/drafts/bookings";
import { FRESH_ICONS } from "../../../../models/fleet/freshKinds";
import { canScheduleFresh, canStartFresh, draftFreshSession, freshKindLabel } from "../../../../models/fleet/freshSession";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";

// A board card's own presses as AgentCard lists them, kept out of the card so its template stays the card: the hovers its
// filing presses wear, the tools its hover bar leads with (CardHoverBar), and which of its presses that bar files where.

// What the card's reactions strip hands its host (AgentReactions' defineExpose): the picker, the quick press, and what
// the reader already wears, which the bar lights.
export interface ReactionsStrip {
    readonly open: (from: HTMLElement) => void;
    readonly toggle: (emoji: string) => Promise<void>;
    readonly worn: ReadonlySet<string>;
    readonly busy: boolean;
}

// What closing actually destroys differs: a `starting` turn keeps running daemon-side (only this window's view of it
// closes). A draft holding unsent text is the one case where closing does lose something, so the hint has to name it.
export const closeTip = (agent: Pick<FleetAgent, "status" | "unsent">): Tip => ({
    title: t(`ui.action.close`),
    note:
        agent.status === `starting`
            ? t(`agents.agentCard.closeKeepsRunning`)
            : agent.unsent
              ? t(`agents.agentCard.closeDropsUnsent`)
              : t(`agents.agentCard.closeNothingKept`),
});

// Archive and restore say how many children ride along, when any do; archive also that nothing is lost by it.
const familyRows = (family: number): Tip[`rows`] => (family > 0 ? [{ label: t(`agents.words.childAgents`), value: family }] : []);

// Everything is kept, except what would go by itself: a message scheduled in it is cancelled (the sandbox's archive.ts),
// since at its time it would only meet a conversation filed away. Said before the press, as the one thing it loses.
export const archiveTip = (agent: Pick<FleetAgent, "queue">, family: number): Tip => {
    const cancels = bookedGroups(agent.queue).reduce((count, group) => count + group.messages.length, 0);
    return {
        title: t(`agents.agentCard.archive`),
        rows: familyRows(family),
        note: cancels > 0 ? t(`agents.agentCard.archiveCancelsScheduled`, { count: cancels }, cancels) : t(`agents.words.allKept`),
    };
};

export const restoreTip = (family: number): TooltipValue =>
    family > 0 ? { title: t(`ui.action.restore`), rows: familyRows(family) } : t(`ui.action.restore`);

// What the card leads somewhere with, in the order the hover bar draws them: its changes, then a code review and a test
// pass of its work. An icon each, so they cost no width at rest; the words are their hovers (and the phone's sheet).
// Every one is a fixed tool, the same icon and the same destination on every card, since a bar is pressed from memory.
// The card's state-dependent drill-in ("Approve", "View error", "Open chat") is not here: it needs its words, and its
// icon could only ever be a generic arrow meaning a different place per card. It lives where it is spelled out (the
// Attention card's summary row, the menu), and a click on the card already opens the chat (2026-11-04).
// The diff is named "View changes" wherever it is offered and never "review": "Code review" is the fresh session
// beside it, and the two read as one press when both said review.
export const toolPresses = (
    agent: FleetAgent,
    card: {
        // Whether the agent's page is offered at all: a phone walks there on a tap, with its changes a swipe away.
        readonly desktop: boolean;
        // Whether the reader may start a turn (useAccess `agent.run`).
        readonly mayRun: boolean;
        readonly openChanges: () => void;
    },
): ActionItem[] => {
    const actions: ActionItem[] = [];
    // Only when the page has something on it (changesToRead): a card that wrote nothing offers no press to a page saying so.
    if (card.desktop && changesToRead(agent)) {
        actions.push({ id: `changes`, label: t(`agents.agentStatus.viewChanges`), icon: `diff`, run: card.openChanges });
    }
    // On work whose turn is still live, the same two presses book the check for that turn's end (canScheduleFresh).
    if ((canStartFresh(agent) || canScheduleFresh(agent)) && card.mayRun) {
        const note = canStartFresh(agent) ? t(`agents.freshSession.howItWorksNote`) : t(`agents.freshSession.afterTurnNote`);
        // Review before test: reading the work is the cheaper check, and the order the session's own menu offers them.
        for (const [id, kind] of [[`codeReview`, `review`], [`test`, `test`]] as const) {
            // The hover keeps the kind's own short name; the note says when a booked one starts.
            const hint = { title: t(`agents.freshSession.kind.${kind}`), note };
            actions.push({ id, label: freshKindLabel(agent, kind), icon: FRESH_ICONS[kind], hint, note, run: () => void draftFreshSession(agent, kind) });
        }
    }
    return actions;
};

// The bar's filing run: everything the card offers that is neither a tool nor the reaction press (the bar draws those
// apart), less rename where the board's menu already holds it.
const TOOL_IDS: ReadonlySet<string> = new Set([`changes`, `codeReview`, `test`, `react`]);
export const barFiling = (actions: readonly ActionItem[], menus: boolean): ActionItem[] =>
    actions.filter((action) => !TOOL_IDS.has(action.id) && (!menus || action.id !== `rename`));
