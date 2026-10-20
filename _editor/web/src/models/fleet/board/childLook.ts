import type { AgentProvider, FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import type { FleetAgent } from "../useAgents-fleet";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { IconName, Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { attentionReason } from "../../agent-status/agentStatus-attention";
import { laneOf } from "../../agent-status/agentStatus-lanes";
import { activityLine, agentDisplayTitle, agentStatusMeta, subagentStatusMeta } from "../../agent-status/agentStatus-meta";
import { limited, onlyOwnerCanAnswer, turnWorking, watching } from "../../agent-status/agentStatus-standing";
import { subagentLive } from "../subagentRoster";
import { modelLabelFor } from "../../providers/providerCatalog";
import { providerAccounts } from "../../providers/providerAccounts";
import { clampEffort, effortsFor } from "../../providers/effortScale";
import { inProcess, subagentTitle, type TrayChild } from "./childFold";
import { FRESH_ICONS } from "../freshKinds";

// What a row in a card's tray draws, read the same way off either kind of child: a conversation the card spawned, or a
// subagent its runtime ran in-process. One shape, so the tray draws one row (ChildRow) and the two kinds cannot drift
// into two looks; each reading below says where the kinds differ and why.

export interface ChildLook {
    readonly title: string;
    // The title's hover: the short word that tells it apart (the kind of subagent an in-process one ran as, or the
    // provider a spawned child runs on when that is not its parent's), which no row or bar draws on its own line, and
    // for an in-process subagent where its press goes, having no chat of its own.
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
    // What it runs on, in words on the row and the bar alike, never behind a hover: the one fact a reader cannot guess
    // from the parent, since a child may run on any model at any tier. Only what was recorded; absent says nothing.
    readonly run: RunLook | undefined;
    // What a fresh session on the parent's work was opened for (freshSession.ts), and what its review found: the word that
    // tells it apart from a child the parent's agent spawned, which it otherwise hangs beside. Absent for every other child.
    readonly fresh: FreshLook | undefined;
}

export interface FreshLook {
    // Drawn in the pill only for the reader's own ask: a review's or a test's row is titled by its kind already.
    readonly label: string | undefined;
    readonly icon: IconName;
    // Its review's count, once it reported one.
    readonly result: string | undefined;
    // Findings still open are the parent's to look at; anything else is said quietly.
    readonly tone: `warning` | `neutral`;
}

const freshLabel = (kind: FreshKind): string => t(`agents.childRows.kind.${kind}`);

const freshLook = (child: Pick<FleetAgent, "fresh" | "review">): FreshLook | undefined => {
    if (child.fresh === undefined) {
        return undefined;
    }
    const review = child.review;
    return {
        label: child.fresh.kind === `ask` ? freshLabel(`ask`) : undefined,
        icon: FRESH_ICONS[child.fresh.kind],
        result:
            review === undefined
                ? undefined
                : review.findings === 0
                  ? t(`agents.childRows.clean`)
                  : t(`agents.childRows.findings`, { count: review.findings }, review.findings),
        tone: review !== undefined && review.open > 0 ? `warning` : `neutral`,
    };
};

// The model by its catalog name ("Opus 5.5", never the alias a call named), and the tier it ran at on that model's own
// ladder, the rungs the composer draws, so a child's tier reads the way the reader set their own.
export interface RunLook {
    // Who serves it, whose mark the bar's model chip wears.
    readonly provider: AgentProvider;
    readonly model: string;
    // The id itself, for the reader who needs the exact string (the chip's accessible name).
    readonly modelId: string;
    readonly effort: EffortLook | undefined;
    // Which connected account pays for it, by the name the reader gave it (the id itself where it is no longer connected
    // here). A child may run on any account of its provider, and which one is spent is the reader's to know.
    readonly account: string | undefined;
}

export interface EffortLook {
    readonly label: string;
    // Its place on the ladder, from 0, and how many rungs the model offers.
    readonly rung: number;
    readonly rungs: number;
}

export const runLook = (
    provider: AgentProvider,
    model: string | undefined,
    effort: string | undefined,
    thinking: boolean | undefined,
    account?: string,
): RunLook | undefined => {
    if (model === undefined || model === ``) {
        return undefined;
    }
    return {
        provider,
        model: modelLabelFor(provider, model),
        modelId: model,
        effort: effortLook(provider, model, effort, thinking),
        account: accountLabel(provider, account),
    };
};

const accountLabel = (provider: AgentProvider, account: string | undefined): string | undefined =>
    account === undefined || account === `` ? undefined : ((providerAccounts.value[provider] ?? []).find((entry) => entry.id === account)?.label ?? account);

// A tier off the model's scale is drawn as the one it runs at (clampEffort); a provider with no ladder names it bare.
const effortLook = (provider: AgentProvider, model: string, effort: string | undefined, thinking: boolean | undefined): EffortLook | undefined => {
    if (effort === undefined || effort === ``) {
        return undefined;
    }
    const ladder = effortsFor(provider, model, thinking);
    const running = clampEffort(effort, provider, model, thinking);
    const rung = ladder.findIndex((option) => option.value === running);
    return rung < 0 ? { label: running, rung: 0, rungs: 0 } : { label: ladder[rung]!.label, rung, rungs: ladder.length };
};

// An in-process subagent: no chat of its own, so its row shows its transcript in its parent's.
const inProcessLook = (child: SubagentSession, provider: AgentProvider, account: string | undefined): ChildLook => {
    const live = subagentLive(child);
    const meta = subagentStatusMeta(child.status);
    const title = subagentTitle(child) ?? t(`shared.subagent`);
    // Claude's default type says nothing worth a hover: only a chosen type (Explore, Plan…) is named.
    const tag = child.agentType === `general-purpose` ? undefined : (child.agentType ?? t(`shared.subagent`));
    return {
        title,
        titleHint: {
            title: tag === undefined || tag === title ? t(`agents.childRows.inProcess`) : `${t(`agents.childRows.inProcess`)} · ${tag}`,
            note: t(`agents.childRows.opensInThisChat`),
        },
        glyph: live ? meta : { ...meta, class: `text-subtle` },
        hint: child.error ?? meta.label,
        ask: undefined,
        quiet: !live,
        working: child.status === `running`,
        since: child.startedAt,
        doing: child.lastTool ?? t(`ui.status.working`),
        at: child.endedAt ?? child.activityAt,
        // Its parent's provider and account: an in-process subagent runs inside the parent's own runtime.
        run: runLook(provider, child.model, child.effort, undefined, account),
        fresh: undefined,
    };
};

// A spawned child's standing glyph, in the card's own vocabulary; settled rows in the ledger's ink.
const spawnedGlyph = (child: FleetAgent, lane: ReturnType<typeof laneOf>): ChildLook[`glyph`] => {
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
};

// Under its origin's card, a review's or a test's row is named by what it is: its own title only repeats the origin's
// name after the kind ("Code review: …"), so it rides the hover instead. The reader's own ask keeps its title, and any
// other child names its provider in the hover when that is not its parent's.
const spawnedTitle = (child: FleetAgent, provider: AgentProvider): Pick<ChildLook, `title` | `titleHint`> => {
    if (child.fresh !== undefined && child.fresh.kind !== `ask`) {
        return { title: freshLabel(child.fresh.kind), titleHint: { title: agentDisplayTitle(child), note: t(`agents.childRows.kindTip`) } };
    }
    return { title: agentDisplayTitle(child), titleHint: child.provider === provider ? undefined : { title: providerLabel(child.provider) } };
};

// `account` is the parent's: what an in-process subagent spends, having no turn of its own.
export const childLook = (child: TrayChild, provider: AgentProvider, account?: string): ChildLook => {
    if (inProcess(child)) {
        return inProcessLook(child, provider, account);
    }
    const lane = laneOf(child);
    // What it asks of the reader; never in the archive, where every press waits for a restore.
    const ask = child.archivedAt === undefined && onlyOwnerCanAnswer(child) ? attentionReason(child) : undefined;
    const glyph = spawnedGlyph(child, lane);
    return {
        ...spawnedTitle(child, provider),
        glyph,
        hint: child.failure ?? glyph.label,
        ask,
        quiet: ask === undefined && lane !== `active`,
        working: turnWorking(child),
        since: child.startedAt,
        doing: activityLine(child) ?? t(`ui.status.working`),
        at: child.updatedAt,
        run: runLook(child.provider, child.model, child.effort, child.thinking, child.account),
        fresh: freshLook(child),
    };
};
