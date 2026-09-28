import { type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import {
    activityLine,
    agentDisplayTitle,
    agentStatusMeta,
    attentionReason,
    laneOf,
    limited,
    onlyOwnerCanAnswer,
    subagentStatusMeta,
    turnWorking,
    watching,
} from "../../fleet/agentStatus";
import { subagentLive } from "../../fleet/subagentRoster";
import { inProcess, subagentTitle, type TrayChild } from "../view/childFold";

// What a row in a card's tray draws, read the same way off either kind of child: a conversation the card spawned, or a
// subagent its runtime ran in-process. One shape, so the tray draws one row (ChildRow) and the two kinds cannot drift
// into two looks; each reading below says where the kinds differ and why.

export interface ChildLook {
    readonly title: string;
    // The title's hover, for the one row whose press does not open its own chat: an in-process subagent has none, and
    // its work is in its parent's, on the card of the call that started it.
    readonly titleHint: string | undefined;
    // Its standing, in the card's own glyphs (agentStatusMeta, subagentStatusMeta); settled rows in the ledger's ink.
    readonly glyph: { readonly icon: IconName; readonly spin?: boolean; readonly label: string; readonly class: string };
    // The glyph's hover: why it failed where it says so, else the standing's word.
    readonly hint: string;
    // What it asks only the reader to give, in the card chip's word. Never for an in-process subagent, which asks
    // through its parent's turn, on the parent's own card.
    readonly ask: string | undefined;
    // Settled or stopped, drawn a step quieter than a row that asks or works.
    readonly quiet: boolean;
    // Its turn is working now, when the clock ticks from `since`.
    readonly working: boolean;
    readonly since: number | undefined;
    // What it is doing right now, in the hover of the clock that says for how long.
    readonly doing: string;
    // When it last moved, for a row that is not working.
    readonly at: number;
    // The short word after the title that tells it apart: the provider a spawned child runs on when that is not its
    // parent's, or the kind of subagent an in-process one ran as.
    readonly tag: string | undefined;
}

export const childLook = (child: TrayChild, provider: AgentProvider): ChildLook => {
    if (inProcess(child)) {
        const live = subagentLive(child);
        const meta = subagentStatusMeta(child.status);
        const title = subagentTitle(child) ?? t(`shared.subagent`);
        const tag = child.agentType ?? t(`shared.subagent`);
        return {
            title,
            titleHint: t(`agents.childRows.inProcessHint`),
            glyph: live ? meta : { ...meta, class: `text-subtle` },
            hint: child.error ?? meta.label,
            ask: undefined,
            quiet: !live,
            working: child.status === `running`,
            since: child.startedAt,
            doing: child.lastTool ?? t(`ui.status.working`),
            at: child.endedAt ?? child.activityAt,
            tag: tag === title ? undefined : tag,
        };
    }
    const lane = laneOf(child);
    // What it asks of the reader; never in the archive, where every press waits for a restore.
    const ask = child.archivedAt === undefined && onlyOwnerCanAnswer(child) ? attentionReason(child) : undefined;
    const glyph = ((): ChildLook[`glyph`] => {
        // An armed watch is why an idle child is in flight at all: its glyph says what it is waiting for, not that it idles.
        if (!turnWorking(child) && watching(child)) {
            return { icon: `eye`, label: t(`agents.childRows.watching`), class: `text-link` };
        }
        // A spent allowance is nothing broken: the clock it waits on, in muted ink, not the error's triangle.
        if (limited(child)) {
            return { icon: `clock`, label: t(`agents.agentStatus.usageLimit`), class: `text-subtle` };
        }
        const meta = agentStatusMeta(child.status);
        return lane === `finished` ? { ...meta, class: `text-subtle` } : meta;
    })();
    return {
        title: agentDisplayTitle(child),
        titleHint: undefined,
        glyph,
        hint: child.failure ?? glyph.label,
        ask,
        quiet: ask === undefined && lane !== `active`,
        working: turnWorking(child),
        since: child.startedAt,
        doing: activityLine(child) ?? t(`ui.status.working`),
        at: child.updatedAt,
        tag: child.provider === provider ? undefined : providerLabel(child.provider),
    };
};
