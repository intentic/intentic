import type { ViewAsk, ViewBadge, ViewRegistration } from "@intentic/extension-api";
import { type AutomationApproval, awaitsOwner, type Need, type NeedKind, type PendingWorkspaceExtension } from "@intentic/sandbox-contract";
import { type IconName, isIconName } from "@intentic/ui/icons";
import { t } from "@intentic/ui/i18n";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import { NEED_ICONS } from "../needStatus";

// Everything waiting on a person, as one list (docs/architecture/needs.md, "Needs you"): what agents asked for, the
// turns parked on an answer in their chat, held automation wakes, extensions waiting to be let in, and whatever an
// extension's view says a person owes it (ViewRegistration.asks). Each source keeps its own way of being answered; this
// only gives them one shape to be listed, counted and ordered by. Pure: no store, no Vue.

// The one question every row answers first: is an agent standing still until this is answered, or can it wait.
export type InboxGroup = "blocking" | "waiting";

interface ItemFacts {
    // Unique across sources (`need:…`, `chat:…`): the selection and the URL hold it.
    readonly key: string;
    // What kind of thing it is, a word or two: the row's lead.
    readonly kind: string;
    readonly icon: IconName;
    // A brand slug drawn as that platform's mark instead of `icon` (an extension's post).
    readonly logo?: string | undefined;
    // What is asked, in one line.
    readonly title: string;
    // Who asked or where it goes: the conversation, the automation, the extension's view.
    readonly context?: string | undefined;
    readonly createdAt?: number | undefined;
    readonly group: InboxGroup;
    // It already tried and broke, and waits on a person to retry or drop it.
    readonly broken?: boolean | undefined;
}

// A parked turn, as far as the inbox reads one: enough to name its park and link to its chat.
export interface ParkedAgent extends AgentStanding {
    readonly id: string;
    readonly title?: string | undefined;
    readonly updatedAt: number;
}

export type InboxItem =
    | (ItemFacts & { readonly source: "need"; readonly need: Need })
    | (ItemFacts & { readonly source: "chat"; readonly agent: ParkedAgent })
    | (ItemFacts & { readonly source: "wake"; readonly wake: AutomationApproval })
    | (ItemFacts & { readonly source: "install"; readonly extension: PendingWorkspaceExtension })
    | (ItemFacts & { readonly source: "view"; readonly view: ViewRegistration; readonly ask: ViewAsk });

const needKind = (kind: NeedKind): string => t(`needs.kind.${kind}`);

// A need stops its conversation only once nothing else is running there: one still running carries on beside it
// (agentStatus.ts `blocked` draws the same line), and one the board no longer lists has no turn to stop.
export const needItem = (need: Need, conversation: { readonly title?: string | undefined; readonly status: string } | undefined): InboxItem => ({
    source: `need`,
    need,
    key: `need:${need.id}`,
    kind: needKind(need.subject.kind),
    icon: NEED_ICONS[need.subject.kind],
    title: need.title,
    context: conversation?.title ?? t(`needs.inbox.untitled`),
    createdAt: need.createdAt,
    group: conversation !== undefined && conversation.status !== `running` && need.status === `open` ? `blocking` : `waiting`,
});

// What a parked turn waits on in its chat, in the rank the board's chip reads (agentStatus.ts ATTENTION_RANK), less the
// two flags that are not a chat's to answer: an open need is listed as itself, and a land conflict is the board's news.
// A bare `awaiting` is a hand-off (a browser, a terminal, a payment) with no flag of its own.
interface Park {
    readonly kind: string;
    readonly icon: IconName;
}
const parkOf = (agent: AgentStanding): Park => {
    const { attention } = agent;
    if (attention.plan) {
        return { kind: t(`agents.agentStatus.approvalNeeded`), icon: `list-check` };
    }
    if (attention.capability) {
        return { kind: t(`agents.agentStatus.setupNeeded`), icon: `bolt` };
    }
    if (attention.credential) {
        return { kind: t(`agents.agentStatus.releaseNeeded`), icon: `unlock` };
    }
    if (attention.question) {
        return { kind: t(`agents.agentStatus.question`), icon: `question-circle` };
    }
    if (attention.permission) {
        return { kind: t(`agents.agentStatus.permission`), icon: `shield` };
    }
    return { kind: t(`agents.agentStatus.waitingOn`), icon: `comments` };
};

// A turn parked mid-way on a person: always blocking, since nothing moves in that conversation until the answer.
export const chatItem = (agent: ParkedAgent): InboxItem => ({
    source: `chat`,
    agent,
    key: `chat:${agent.id}`,
    ...parkOf(agent),
    title: agent.title ?? t(`needs.inbox.untitled`),
    context: t(`needs.inbox.inItsChat`),
    createdAt: agent.updatedAt,
    group: `blocking`,
});

// A held wake with no countdown: the automation fired and waits for a yes before it starts a conversation. One with a
// countdown starts on its own and owes nobody anything, so it is never passed here (see `waitingWakes`).
export const wakeItem = (wake: AutomationApproval): InboxItem => ({
    source: `wake`,
    wake,
    key: `wake:${wake.id}`,
    kind: t(`needs.kind.automation`),
    icon: `automations`,
    title: wake.title ?? wake.automationId,
    context: wake.automationId,
    createdAt: wake.createdAt,
    group: `waiting`,
});

export const waitingWakes = (held: readonly AutomationApproval[]): readonly AutomationApproval[] => held.filter(awaitsOwner);

// An extension written in this workspace that runs nothing until the owner says yes to what it asks for.
export const installItem = (extension: PendingWorkspaceExtension): InboxItem => ({
    source: `install`,
    extension,
    key: `install:${extension.id}`,
    kind: t(`needs.kind.extension`),
    icon: `extensions`,
    title: extension.approvedBefore ? t(`needs.inbox.extensionAsksMore`, { id: extension.id }) : t(`needs.inbox.extensionInstall`, { id: extension.id }),
    context: `.intentic/config/workspace-extensions/${extension.dir}`,
    group: `waiting`,
});

// An extension view's own ask, said under that view's name. Its glyph is the ask's if the host knows it, else the one
// every ask can fall back to.
export const viewItem = (view: ViewRegistration, ask: ViewAsk): InboxItem => ({
    source: `view`,
    view,
    ask,
    key: `view:${view.id}:${ask.id}`,
    kind: ask.kind,
    icon: ask.icon !== undefined && isIconName(ask.icon) ? ask.icon : `check-square`,
    logo: ask.logo,
    title: ask.title,
    context: ask.context === undefined ? view.label : `${view.label} · ${ask.context}`,
    createdAt: ask.createdAt,
    group: `waiting`,
    broken: ask.tone === `danger`,
});

// What has waited longest leads, a broken one ahead of everything in its group since it already tried and stopped;
// one that never said when sorts last rather than first on a 0.
const byUrgency = (left: InboxItem, right: InboxItem): number =>
    Number(right.broken === true) - Number(left.broken === true) || (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER);

export interface InboxSection {
    readonly group: InboxGroup;
    readonly items: readonly InboxItem[];
}

// Blocking first, then the rest; an empty group draws no heading.
export const inboxSections = (items: readonly InboxItem[]): readonly InboxSection[] =>
    ([`blocking`, `waiting`] as const)
        .map((group) => ({ group, items: items.filter((item) => item.group === group).toSorted(byUrgency) }))
        .filter((section) => section.items.length > 0);

// The order the list is read in, for "answer this, then the next one".
export const inboxOrder = (items: readonly InboxItem[]): readonly InboxItem[] => inboxSections(items).flatMap((section) => section.items);

// Where the selection goes when the selected item leaves (answered, withdrawn): the one that took its place in the
// order, else the one before it, else nothing. `before` is the order the reader was looking at.
export const nextAfter = (before: readonly InboxItem[], after: readonly InboxItem[], gone: string): string | undefined => {
    const at = before.findIndex((item) => item.key === gone);
    const still = new Set(after.map((item) => item.key));
    const following = before.slice(at + 1).find((item) => still.has(item.key));
    const preceding = before
        .slice(0, Math.max(at, 0))
        .toReversed()
        .find((item) => still.has(item.key));
    return (following ?? preceding ?? after[0])?.key;
};

// The one count for the rail tile and the phone's tab: warning while an agent is standing still on one, danger while
// one already broke, else the resting tone for owed work.
export const inboxBadge = (items: readonly InboxItem[]): ViewBadge | undefined => {
    if (items.length === 0) {
        return undefined;
    }
    const blocking = items.filter((item) => item.group === `blocking`).length;
    const tone = items.some((item) => item.broken === true) ? `danger` : blocking > 0 ? `warning` : `info`;
    return {
        count: items.length,
        tone,
        tooltip: blocking > 0 ? t(`needs.inbox.badgeBlocking`, { count: items.length, blocking }) : t(`needs.inbox.waiting`, { count: items.length }),
    };
};
