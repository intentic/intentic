import { type AgentProvider, providerLabel } from "@intentic/sandbox-contract";
import type { IconName, Tip } from "@intentic/ui";
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
import { modelLabelFor } from "../../../chat/accounts/providerCatalog";
import { effortLabelOf } from "../../../chat/models/run-settings/effortScale";
import { inProcess, subagentTitle, type TrayChild } from "../view/childFold";

// What a row in a card's tray draws, read the same way off either kind of child: a conversation the card spawned, or a
// subagent its runtime ran in-process. One shape, so the tray draws one row (ChildRow) and the two kinds cannot drift
// into two looks; each reading below says where the kinds differ and why.

export interface ChildLook {
    readonly title: string;
    // The title's hover: what it runs on (run), and for the one row whose press does not open its own chat, where its
    // work is instead: an in-process subagent has none, and its work is in its parent's, on the card of the call that
    // started it. The row itself stays one line; the model is a hover away there, and on the bar of its chat.
    readonly titleHint: Tip | undefined;
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
    // What it runs on, "Opus 4.7 · High", with the exact ids in its hover: the one fact a reader cannot guess from the
    // parent, since a child may be pinned to any model and tier. Only what was recorded: an in-process subagent reports
    // a model only when its call named one, and never a tier, so it says nothing it would have to guess.
    readonly run: RunLook | undefined;
}

export interface RunLook {
    readonly label: string;
    readonly tip: Tip;
}

export const runLook = (
    provider: AgentProvider,
    model: string | undefined,
    effort: string | undefined,
    thinking: boolean | undefined,
): RunLook | undefined => {
    if (model === undefined || model === ``) {
        return undefined;
    }
    const tier = effortLabelOf(effort, provider, model, thinking);
    const name = modelLabelFor(provider, model);
    return {
        label: tier === undefined ? name : `${name} · ${tier}`,
        tip: {
            title: name,
            rows: [
                { label: t(`agents.words.provider`), value: providerLabel(provider) },
                { label: t(`shared.model`), value: model },
                ...(tier === undefined ? [] : [{ label: t(`shared.effort`), value: tier }]),
            ],
        },
    };
};

export const childLook = (child: TrayChild, provider: AgentProvider): ChildLook => {
    if (inProcess(child)) {
        const live = subagentLive(child);
        const meta = subagentStatusMeta(child.status);
        const title = subagentTitle(child) ?? t(`shared.subagent`);
        const tag = child.agentType ?? t(`shared.subagent`);
        const run = runLook(provider, child.model, undefined, undefined);
        return {
            title,
            titleHint: { title: t(`agents.childRows.inProcess`), rows: run?.tip.rows, note: t(`agents.childRows.opensInThisChat`) },
            glyph: live ? meta : { ...meta, class: `text-subtle` },
            hint: child.error ?? meta.label,
            ask: undefined,
            quiet: !live,
            working: child.status === `running`,
            since: child.startedAt,
            doing: child.lastTool ?? t(`ui.status.working`),
            at: child.endedAt ?? child.activityAt,
            tag: tag === title ? undefined : tag,
            run,
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
    const run = runLook(child.provider, child.model, child.effort, child.thinking);
    return {
        title: agentDisplayTitle(child),
        titleHint: run?.tip,
        glyph,
        hint: child.failure ?? glyph.label,
        ask,
        quiet: ask === undefined && lane !== `active`,
        working: turnWorking(child),
        since: child.startedAt,
        doing: activityLine(child) ?? t(`ui.status.working`),
        at: child.updatedAt,
        tag: child.provider === provider ? undefined : providerLabel(child.provider),
        run,
    };
};
