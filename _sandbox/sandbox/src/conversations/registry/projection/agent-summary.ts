import type { AgentChecklist, AgentReaction, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { keepWarmCap } from "@intentic/sandbox-contract/schemas/keep-warm";
import { opt } from "../../../opt.js";
import { queueView } from "../../actor/conversation-queue.js";
import { awaitingWake, type ConversationState, type TurnUsage, nextPromptDayAt } from "../../actor/conversation-state.js";
import type { PersistedAgent, Postures, Social, Totals } from "../agents-store.js";

// Live context readings: how full the window is, how large it is, and how long what is already cached stays cheap to
// re-send. One clause on the summary, since no reader wants one without the others.
const contextFill = (state: ConversationState | undefined): Pick<AgentSummary, "contextTokens" | "contextWindow" | "promptCache" | "keepWarm"> => ({
    ...opt("contextTokens", state?.turn.contextTokens),
    ...opt("contextWindow", state?.turn.contextWindow),
    ...opt("promptCache", cacheClock(state)),
    ...opt("keepWarm", state?.keepWarm),
});

// The cache's deadline, the date change, and how far a hold could reach where the daemon can keep it: its provider's
// refresh budget, less what a live hold already spent (the same cap arming applies, cache-keepwarm.ts).
const cacheClock = (state: ConversationState | undefined): AgentSummary["promptCache"] => {
    const cache = state?.turn.promptCache;
    if (state === undefined || cache === undefined) {
        return undefined;
    }
    const rollsAt = nextPromptDayAt(cache.at);
    const budget = state.turn.keepable?.budget;
    const spent = state.keepWarm?.ended === undefined ? (state.keepWarm?.refreshes ?? 0) : 0;
    return { ...cache, rollsAt, ...opt("keepableUntil", budget === undefined ? undefined : keepWarmCap(cache, rollsAt, budget - spent)) };
};

// Where the checklist stands, for a card rather than for a verdict: the live list while the daemon still holds it,
// else what the last turn recorded as left open. An empty list is no list, and says so by carrying nothing.
const checklistOf = (entry: PersistedAgent, state: ConversationState | undefined): AgentChecklist | undefined => {
    const live = state?.turn.checklist;
    if (live !== undefined) {
        return live.length === 0 ? undefined : { done: live.filter((item) => item.status === "completed").length, total: live.length };
    }
    // The only reading that survives a daemon restart, and only for a turn that ended with work open: `unfinished` is
    // persisted, the runtime list is not.
    const steps = entry.unfinished?.steps;
    return steps === undefined ? undefined : { done: steps.total - steps.open, total: steps.total };
};

// What the actor keeps for its card between turns; nothing for a conversation this daemon has not heard from.
const cardReadings = (state: ConversationState | undefined): Partial<Pick<ConversationState, "loop" | "workflow" | "watches" | "jobs" | "needs">> =>
    state ?? {};

// The per-conversation overrides of a sandbox-wide default (absent means inherit), projected together since the card's
// menu and the chat's control read them together.
export const postures = (held: Postures): Partial<Pick<AgentSummary, "autoLand" | "limitPolicy" | "outagePolicy" | "stopPolicy" | "memoryPolicy">> => ({
    ...opt("autoLand", held.autoLand),
    ...opt("limitPolicy", held.limit),
    ...opt("outagePolicy", held.outage),
    ...opt("stopPolicy", held.stopped),
    ...opt("memoryPolicy", held.memory),
});

// Flat presses grouped into the card's chips. Both orders come straight off press order — the emoji by whoever used it
// first, the names within one by who marked it first — so a second person pressing an existing chip never moves it.
const groupedReactions = (reactions: Social["reactions"]): AgentReaction[] | undefined => {
    if (reactions.length === 0) {
        return undefined;
    }
    const chips = new Map<string, AgentReaction>();
    for (const { emoji, email, name, at } of reactions) {
        const who = { email, ...(name !== undefined ? { name } : {}), at };
        const chip = chips.get(emoji);
        if (chip === undefined) {
            chips.set(emoji, { emoji, by: [who] });
        } else {
            chip.by.push(who);
        }
    }
    return [...chips.values()];
};

// What the entry says the last turn left open, except while a turn is running, where it would be noise on a card
// already working through that very list.
export const reportedUnfinished = (entry: PersistedAgent, state: ConversationState | undefined): Partial<Pick<AgentSummary, "unfinished">> =>
    state?.phase.kind === "running" ? {} : opt("unfinished", entry.unfinished);

// Written onto the entry at every change, so a conversation no actor has heard of since a restart shows it too.
export const queueClause = ({ queue }: PersistedAgent): Pick<AgentSummary, "queue"> => (queue === undefined ? {} : { queue: queueView(queue) });

// What the card says the conversation is: where it works, where it came from and as whom, its name, who answers for it
// and what people left on it, and the settings its last turn ran under.
export const describedBy = ({ placement, identity, profile, social, sessionId, archivedAt }: PersistedAgent) => ({
    provider: profile.provider,
    harness: profile.harness,
    ...(placement.kind === "worktree" ? { branch: placement.branch, ...opt("runner", placement.runner) } : {}),
    ...opt("startIn", identity.startIn),
    ...opt("actsAs", identity.actsAs),
    ...opt("lastActsAs", profile.actsAs),
    ...opt("sessionId", sessionId),
    ...opt("origin", identity.origin),
    ...opt("startedBy", identity.startedBy),
    ...opt("owner", social.owner),
    // The fence it was born with, on the summary because visibleTo() filters summaries: without it every fenced reader's
    // board is empty, their own conversations included.
    ...opt("areas", identity.areas),
    ...opt("forkedFrom", identity.forkedFrom),
    ...opt("fresh", identity.fresh),
    ...opt("home", identity.home),
    ...opt("title", social.title?.text),
    ...opt("titleAction", social.title?.action),
    ...opt("model", profile.model),
    ...opt("effort", profile.effort),
    ...opt("thinking", profile.thinking),
    ...opt("fast", profile.fast),
    ...opt("account", profile.account),
    ...opt("landRequested", social.landRequested),
    ...opt("reactions", groupedReactions(social.reactions)),
    ...opt("seenAt", social.seenAt),
    ...opt("unsentAt", social.unsentAt),
    ...opt("archivedAt", archivedAt),
});

// Lifetime totals plus the running turn's not-yet-flushed usage, each shown once it is more than nothing, so a chip
// appears on content rather than as a column of zeros. Subagents: the running count from the roster its actors hold,
// the lifetime total from the entry, since the roster forgets a finished child.
export const spentBy = (totals: Totals, usage: TurnUsage, running: number) => {
    const costUsd = totals.costUsd + usage.costUsd;
    const inputTokens = totals.inputTokens + usage.inputTokens;
    const outputTokens = totals.outputTokens + usage.outputTokens;
    const toolUses = totals.toolUses + usage.toolUses;
    const subagents = { running, total: totals.subagents + usage.subagents };
    return {
        ...(costUsd > 0 ? { costUsd } : {}),
        ...(inputTokens > 0 ? { inputTokens } : {}),
        ...(outputTokens > 0 ? { outputTokens } : {}),
        ...(totals.turns > 0 ? { turns: totals.turns } : {}),
        ...(toolUses > 0 ? { toolUses } : {}),
        ...(subagents.total > 0 ? { subagents } : {}),
    };
};

// What the actor holds for the card: the live turn's readings, the checklist, and the loop, workflow, watches and jobs
// its pumps last published. An empty list is turned absent, indistinguishable from never having watched.
export const liveReadings = (entry: PersistedAgent, state: ConversationState | undefined) => {
    const { loop, workflow, watches, jobs, needs } = cardReadings(state);
    return {
        ...contextFill(state),
        ...opt("activity", state?.turn.activity),
        ...opt("checklist", checklistOf(entry, state)),
        ...(state?.phase.kind === "running" ? { startedAt: state.phase.startedAt } : {}),
        ...opt("loop", loop),
        ...opt("workflow", workflow),
        ...(watches !== undefined && watches.length > 0 ? { watches: [...watches] } : {}),
        awaitingWake: state !== undefined && awaitingWake(state),
        ...(jobs !== undefined && jobs.length > 0 ? { jobs: [...jobs] } : {}),
        ...(needs !== undefined && needs.length > 0 ? { needs: [...needs] } : {}),
    };
};
