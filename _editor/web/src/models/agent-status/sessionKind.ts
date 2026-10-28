import type { IconName } from "@intentic/ui";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { CI_FIX_PREFIX, LAND_FIX_PREFIX } from "@intentic/sandbox-contract/ids/conversation-ids";
import { t } from "@intentic/ui/i18n";
import { contextPct, originMeta } from "./agentStatus-meta";

// WHAT A SESSION CARD'S TILE SAYS: what kind of session it is, in the glyph, and how full its context window is, in the
// colour (contextPressure). It replaced a kind-of-work glyph (fix, feat, refactor) read off the title's first verb, which only ever
// repeated the word beside it and told two cards apart by nothing a reader was scanning for.
//
// MARK THE EXCEPTION, NOT THE RULE. Most sessions are one person's single agent, so that kind draws an empty disc: a glyph
// on nearly every card would be the same noise again. Every other kind is rare on a board and earns a glyph of its own.
// THE COLOUR IS RARE TOO. It used to be the package a session worked in, but a hue per package is a mapping nobody
// learns, so it told cards apart by nothing a reader could decode. It is now the one reading that is ordered and asks a
// question at a glance, whether this session can take more work: no colour while there is room, amber as it fills.

// The facts the tile reads, all of them on a summary already; a row with no agent behind it passes none.
export type SessionFacts = Pick<AgentSummary, "id"> &
    Partial<Pick<AgentSummary, "home" | "origin" | "startedBy" | "fresh" | "forkedFrom" | "subagents" | "modules" | "contextTokens" | "contextWindow">>;

export type SessionKindName = `home` | `automation` | `fixer` | `review` | `test` | `ask` | `fork` | `orchestrator` | `child` | `solo`;

export interface SessionKind {
    readonly name: SessionKindName;
    // Undefined for the kinds an empty disc stands for: the everyday single agent, and a child, which already stands under the
    // parent that started it.
    readonly icon: IconName | undefined;
    // Said in the tile's hover, the one place the kind is put in words.
    readonly label: string;
}

// A session opened on another's finished work, by what it was opened for.
const freshKinds = () =>
    ({
        review: { icon: `eye`, label: t(`agents.sessionKind.review`) },
        test: { icon: `flask`, label: t(`agents.sessionKind.test`) },
        ask: { icon: `comments`, label: t(`agents.sessionKind.ask`) },
    }) satisfies Record<NonNullable<AgentSummary["fresh"]>["kind"], { icon: IconName; label: string }>;

// Most particular first: a home and an automation's run are what they are whoever they spawn; a session that started
// subagents and is none of the rarer kinds is an orchestrator. Its live count of working children rides the tile as a
// badge for any kind, so a home running three helpers says so too.
export const sessionKind = (session: SessionFacts | undefined): SessionKind => {
    if (session?.home === true) {
        return { name: `home`, icon: `home`, label: t(`agents.sessionKind.home`) };
    }
    if (session?.origin !== undefined) {
        const source = originMeta(session.origin);
        return { name: `automation`, icon: source.icon, label: t(`agents.sessionKind.automation`, { source: source.label }) };
    }
    if (session !== undefined && (session.id.startsWith(CI_FIX_PREFIX) || session.id.startsWith(LAND_FIX_PREFIX))) {
        return { name: `fixer`, icon: `pipelines`, label: t(`agents.sessionKind.fixer`) };
    }
    if (session?.fresh !== undefined) {
        return { name: session.fresh.kind, ...freshKinds()[session.fresh.kind] };
    }
    if (session?.forkedFrom !== undefined) {
        return { name: `fork`, icon: `fork`, label: t(`agents.sessionKind.fork`) };
    }
    if ((session?.subagents?.total ?? 0) > 0) {
        return { name: `orchestrator`, icon: `subagents`, label: t(`agents.sessionKind.orchestrator`) };
    }
    if (session?.startedBy?.startsWith(`agent:`) === true) {
        return { name: `child`, icon: undefined, label: t(`agents.sessionKind.child`) };
    }
    return { name: `solo`, icon: undefined, label: t(`agents.sessionKind.solo`) };
};

// The package a session works in, its most-changed one, named in the tile's hover. Words only: as a colour it was
// a key nobody could read.
export interface SessionModule {
    readonly name: string;
}

export const sessionModule = (session: SessionFacts | undefined): SessionModule | undefined => {
    const name = session?.modules?.[0];
    return name === undefined ? undefined : { name };
};

// How close a session is to its context window's end, as the tile's colour: nothing below 70%, `filling` from 70%
// (the next long turn may be compacted), `full` from 90% (start a fresh session rather than resume this one). Amber,
// never red, since red on a card is a failure (the corner, the stamps). The exact figure is in the tile's hover.
export type ContextPressure = `filling` | `full`;
const FILLING_PCT = 70;
const FULL_PCT = 90;

export const contextPressure = (session: SessionFacts | undefined): ContextPressure | undefined => {
    const percent = contextPct(session?.contextTokens, session?.contextWindow);
    if (percent === undefined || percent < FILLING_PCT) {
        return undefined;
    }
    return percent >= FULL_PCT ? `full` : `filling`;
};
