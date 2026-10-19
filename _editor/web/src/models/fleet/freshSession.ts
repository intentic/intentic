import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import type { FreshKind } from "@intentic/sandbox-contract/schemas/agent";
import { t } from "@intentic/ui/i18n";
import { agentDisplayTitle } from "../agent-status/agentStatus-meta";
import { turnWorking } from "../agent-status/agentStatus-standing";
import { ensureProviderCommands } from "../conversations/accounts/useChat-catalog";
import { draftConversation, openAgentConversation } from "../conversations/panel/useChat-reveal";
import { summonChat } from "../conversations/run/summon";
import type { Conversation } from "../conversations/session/conversation";
import { providerCommands } from "../providers/providerCatalog";
import { reviewCommandOf } from "../providers/reviewCommands";
import { revealConversation } from "./agentActions";
import type { FleetAgent } from "./useAgents-fleet";
import { CHECK_KINDS, type CheckKind } from "./freshKinds";

// A FRESH SESSION ON AN AGENT'S WORK: a new chat that opens on that work as it stands now, with none of the conversation
// that produced it (schemas/agent.ts FreshOfSchema). It is how a review or a test judges the work rather than the
// reasoning behind it, which is how each harness's own reviewer runs (Claude Code's /code-review in a forked subagent,
// Codex's /review in a thread of its own). The daemon hangs it under the origin's card and lands its edits back into the
// origin's work; its findings reach the origin only when the reader sends them (ChatReviewCard's Fix).
//
// The ask goes into a composer, never straight out: the reader picks the model, a review level or a target, or writes
// their own ask, and presses Send.

// What each kind opens with: each harness's own reviewer by the name its `/` list publishes (reviewCommands.ts), else the
// ask in words; a test pass in words; the reader's own ask empty.
export const freshDraft = (kind: FreshKind, commands: readonly AgentCommand[]): string => {
    if (kind === `review`) {
        const command = reviewCommandOf(commands);
        return command === undefined ? t(`agents.freshSession.reviewInWords`) : `/${command} `;
    }
    return kind === `test` ? t(`agents.freshSession.testInWords`) : ``;
};

// The list the composer's `/` popover reads (useChat-view's availableCommands): the conversation's own, else its
// provider's, fetched first where nothing is known yet.
const commandsOf = async (conversation: Conversation): Promise<readonly AgentCommand[]> => {
    if (conversation.availableCommands.value.length > 0) {
        return conversation.availableCommands.value;
    }
    const provider = conversation.selection.provider.value;
    // allow(silent-catch): a list nobody could fetch leaves the ask in words, which every harness answers
    await ensureProviderCommands(provider).catch(() => undefined);
    return providerCommands.value[provider] ?? [];
};

// Whether a fresh session can be started on this card's work: its own private copy here (the daemon cuts the new one from
// it and lands back into it; a runner's copy is on another machine), something in it to look at, not filed away, and not
// itself a fresh session, so a review of a review never stacks a second level under one card.
export const canStartFresh = (
    agent: Pick<FleetAgent, "archivedAt" | "fresh" | "branch" | "runner" | "diff" | "sandboxId">,
): boolean =>
    agent.sandboxId === undefined &&
    agent.archivedAt === undefined &&
    agent.fresh === undefined &&
    agent.branch !== undefined &&
    agent.runner === undefined &&
    (agent.diff?.files ?? 0) > 0;

// The title the new chat opens with, so the board names it by what it is for rather than by `/code-review`.
const freshTitle = (kind: FreshKind, origin: FleetAgent): string | null =>
    kind === `ask` ? null : t(`agents.freshSession.title.${kind}`, { title: agentDisplayTitle(origin) });

// Opens a new chat on `origin`'s work with the kind's ask in its composer. The persona and project ride across, since
// the daemon cuts the new copy from the origin's own repos; the model is the composer's, the reader's to change.
export const draftFreshSession = async (origin: FleetAgent, kind: FreshKind): Promise<void> => {
    const conversation = draftConversation();
    conversation.isolated.value = true;
    conversation.pendingForkOf.value = undefined;
    conversation.pendingFreshOf.value = { conversationId: origin.id, kind };
    conversation.selection.apply({ kind: `set`, picks: { actsAs: origin.actsAs, startIn: origin.startIn } });
    conversation.title.value = freshTitle(kind, origin);
    conversation.draft.value = freshDraft(kind, await commandsOf(conversation));
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
};

// A fresh session's findings, put in its origin's composer after whatever the reader already wrote there: the agent that
// made the work is the one that knows which findings hold. Never sent: the reader presses Send.
export const draftInOrigin = (origin: FleetAgent, text: string): void => {
    const conversation = openAgentConversation(origin);
    const draft = conversation.draft.value.trim();
    conversation.draft.value = draft === `` ? text : `${draft}\n\n${text}`;
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
};

// Whether the composer still holds only what the strip put there: a draft the reader wrote over is theirs, and switching
// the kind or the provider never replaces it.
const untouched = (draft: string, templates: readonly string[]): boolean => draft.trim() === `` || templates.some((template) => template.trim() === draft.trim());

// Another kind for the session not yet sent: its ask replaces the draft only while the draft is still the strip's.
export const switchFreshKind = async (conversation: Conversation, origin: FleetAgent | undefined, kind: FreshKind): Promise<void> => {
    const pending = conversation.pendingFreshOf.value;
    if (pending === undefined || pending.kind === kind) {
        return;
    }
    const commands = await commandsOf(conversation);
    const before = conversation.draft.value;
    conversation.pendingFreshOf.value = { ...pending, kind };
    if (untouched(before, [freshDraft(pending.kind, commands)])) {
        conversation.draft.value = freshDraft(kind, commands);
    }
    if (origin !== undefined && (conversation.title.value === null || conversation.title.value === freshTitle(pending.kind, origin))) {
        conversation.title.value = freshTitle(kind, origin);
    }
};

// The provider changed under a draft the strip wrote: its reviewer may answer to another name (`/code-review`, `/review`).
export const refreshFreshDraft = async (conversation: Conversation, previous: readonly AgentCommand[]): Promise<void> => {
    const pending = conversation.pendingFreshOf.value;
    if (pending === undefined) {
        return;
    }
    const commands = await commandsOf(conversation);
    if (untouched(conversation.draft.value, [freshDraft(pending.kind, previous)])) {
        conversation.draft.value = freshDraft(pending.kind, commands);
    }
};

// Back to an ordinary new chat: the link goes, and the strip's own ask with it unless the reader made it theirs.
export const unlinkFresh = async (conversation: Conversation): Promise<void> => {
    const pending = conversation.pendingFreshOf.value;
    if (pending === undefined) {
        return;
    }
    const commands = await commandsOf(conversation);
    conversation.pendingFreshOf.value = undefined;
    if (untouched(conversation.draft.value, [freshDraft(pending.kind, commands)])) {
        conversation.draft.value = ``;
    }
    conversation.title.value = null;
};

// WHAT A CARD SAYS OF THE CHECKS ON ITS WORK: one marker per kind of check that has looked at it (a code review, a test
// pass, any kind added later), the latest of each, read off the fleet. None is asked for and none gates anything: a card
// nobody checked says nothing about it. A fresh session's check outranks a review the agent ran in its own chat, which
// had read how the work was made; any goes stale once the work changed after it began.
export interface CheckMarker {
    readonly kind: CheckKind;
    // The conversation it ran in: a fresh session under the card, or the card's own for a review it ran on itself.
    readonly by: string;
    readonly own: boolean;
    // Findings and clean come from a reviewer's findings card; done is a check that answered in prose.
    readonly state: `running` | `findings` | `clean` | `done` | `failed`;
    readonly findings?: number;
    readonly open?: number;
    readonly stale: boolean;
}

const changedSince = (origin: Pick<FleetAgent, "proof">, at: number): boolean => origin.proof !== undefined && origin.proof.at > at;

const tallied = (tally: NonNullable<FleetAgent[`review`]>): Pick<CheckMarker, `state` | `findings` | `open`> =>
    tally.findings === 0 ? { state: `clean` } : { state: `findings`, findings: tally.findings, open: tally.open };

// The latest fresh session of this kind on the origin's work that has run at all (a first message still held says
// nothing yet), as a marker.
const freshCheck = (origin: FleetAgent, fleet: readonly FleetAgent[], kind: CheckKind): CheckMarker | undefined => {
    const latest = fleet
        .filter((agent) => agent.fresh?.of === origin.id && agent.fresh.kind === kind && agent.archivedAt === undefined)
        .filter((agent) => turnWorking(agent) || (agent.turns ?? 0) > 0)
        .toSorted((a, b) => (b.fresh?.at ?? 0) - (a.fresh?.at ?? 0))[0];
    if (latest?.fresh === undefined) {
        return undefined;
    }
    const base = { kind, by: latest.id, own: false, stale: changedSince(origin, latest.fresh.at) };
    if (turnWorking(latest)) {
        return { ...base, state: `running`, stale: false };
    }
    if (latest.review !== undefined) {
        return { ...base, ...tallied(latest.review) };
    }
    return { ...base, state: latest.status === `error` || latest.failure !== undefined ? `failed` : `done` };
};

export const checksOf = (origin: FleetAgent, fleet: readonly FleetAgent[]): CheckMarker[] =>
    CHECK_KINDS.flatMap((kind): CheckMarker[] => {
        const fresh = freshCheck(origin, fleet, kind);
        if (fresh !== undefined) {
            return [fresh];
        }
        // A review the agent ran in its own chat (a typed /code-review), marked as its own.
        const own = kind === `review` ? origin.review : undefined;
        return own === undefined ? [] : [{ kind, by: origin.id, own: true, stale: changedSince(origin, own.at), ...tallied(own) }];
    });
