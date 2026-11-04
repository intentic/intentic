import type { ActionItem, Tip, TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { reviewBesideDrill } from "../../../../models/agent-status/agentStatus-attention";
import { bookedGroups } from "../../../../models/conversations/drafts/bookings";
import { FRESH_ICONS } from "../../../../models/fleet/freshKinds";
import { canStartFresh, draftFreshSession } from "../../../../models/fleet/freshSession";
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

// What the card leads somewhere with, in the order the hover bar draws them: its changes (or the drill-in, where that goes
// elsewhere), then a code review and a test pass of its work. An icon each, so they cost no width at rest; the words are their hovers
// (and the phone's sheet). The diff is named "View changes" wherever it is offered and never "review": "Code review" is
// the fresh session beside it, and the two read as one press when both said review (2026-11-04).
export const toolPresses = (
    agent: FleetAgent,
    card: {
        // The drill-in's words, absent where there is none (a draft, a phone).
        readonly review: string | undefined;
        // The Attention card spells its drill-in out in the summary row, so the bar does not draw it twice.
        readonly rowDrill: boolean;
        // Whether the reader may start a turn (useAccess `agent.run`).
        readonly mayRun: boolean;
        readonly drillIn: () => void;
        readonly openChanges: () => void;
    },
): ActionItem[] => {
    const actions: ActionItem[] = [];
    const viewChanges = t(`agents.agentStatus.viewChanges`);
    if (card.review !== undefined && !card.rowDrill) {
        actions.push({ id: `review`, label: card.review, icon: card.review === viewChanges ? `diff` : `arrow-right`, run: card.drillIn });
    }
    // A card whose drill-in goes to the chat (an ask, a spent allowance) still has its written work one press away.
    if (card.review !== undefined && reviewBesideDrill(agent)) {
        actions.push({ id: `changes`, label: viewChanges, icon: `diff`, run: card.openChanges });
    }
    if (canStartFresh(agent) && card.mayRun) {
        const note = t(`agents.freshSession.howItWorksNote`);
        // Review before test: reading the work is the cheaper check, and the order the session's own menu offers them.
        for (const [id, kind] of [[`codeReview`, `review`], [`test`, `test`]] as const) {
            const label = t(`agents.freshSession.kind.${kind}`);
            actions.push({ id, label, icon: FRESH_ICONS[kind], hint: { title: label, note }, note, run: () => void draftFreshSession(agent, kind) });
        }
    }
    return actions;
};

// The bar's filing run: everything the card offers that is neither a tool nor the reaction press (the bar draws those
// apart), less rename where the board's menu already holds it.
const TOOL_IDS: ReadonlySet<string> = new Set([`review`, `changes`, `codeReview`, `test`, `react`]);
export const barFiling = (actions: readonly ActionItem[], menus: boolean): ActionItem[] =>
    actions.filter((action) => !TOOL_IDS.has(action.id) && (!menus || action.id !== `rename`));
