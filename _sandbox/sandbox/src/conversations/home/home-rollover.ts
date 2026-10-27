import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { FreshStartWhy } from "@intentic/sandbox-contract/schemas/providers/handoff";
import { parentOfActor } from "../../auth/principal.js";
import type { Services } from "../../composition.js";
import type { RoutedTurn } from "../../seams/turn-starter.js";

// HOW A HOME CONVERSATION STAYS AS CHEAP AS AN ORDINARY ONE (contract: schemas/providers/handoff.ts FreshStartSchema).
// A home is one chat kept for good (home-conversation.ts), so left alone its session grows until the model's window
// forces a compaction, and every call of every turn re-reads all of it first: in this sandbox's spend ledger
// (2026-10-13..27) a turn ending at 100-150k tokens of context cost about $1 on average, one ending at 300-500k about
// $9 (`bench:home` reads the same ledger for homes). So a home's turn
// opens a fresh session instead of resuming its old one when:
//   budget  its context has reached the sandbox's `homeFreshOver`;
//   cold    it has reached half of that and its prompt cache has expired, so resuming would write it all again anyway;
//   asked   its person pressed Start fresh (agents.startFreshHome);
//   cleared its person cleared its history (agents.clearHomeHistory).
// The fresh session opens with a summary a smaller model wrote, where one is set for hand-off summaries (the turn's
// agent/run/turn/holds/turn-continuation.ts asks, and limit-handoff.ts summaryNote writes it with the instructions below), the newest part of the conversation word for word
// (runtime-history.ts), where the work stands (the hand-off's own state note), the subagents it started and what each
// holds (homeWorkNote), and its home policy again (home-policy.ts homeNoteIfDue reads the session being fresh). Its
// transcript keeps every row; a `fresh_start` row says where the model's memory starts over.

// The cache clock's own margin, as the cold trim reads it (cold-trim.ts): an expiry edge kept whole.
const COLD_MARGIN_MS = 30_000;

export interface RolloverBasis {
    readonly home: boolean;
    // What Start fresh or Clear history left for this turn (PersistedAgent.freshPending).
    readonly pending: "asked" | "cleared" | undefined;
    // The session the turn would resume; none means it opens fresh anyway, and only a pending ask has anything to say.
    readonly sessionId: string | undefined;
    // A re-run of a held turn, a fork or a cut: each already decides how it goes on, which this does not overrule.
    readonly continuing: boolean;
    readonly contextTokens: number | undefined;
    readonly promptCache: { readonly at: number; readonly ttlMs: number } | undefined;
    // `homeFreshOver`; zero never rolls over by size.
    readonly budget: number;
    readonly now: number;
}

const cold = (cache: RolloverBasis["promptCache"], now: number): boolean =>
    cache !== undefined && Number.isFinite(cache.at) && Number.isFinite(cache.ttlMs) && cache.ttlMs > 0 && now > cache.at + cache.ttlMs + COLD_MARGIN_MS;

/** Why this home turn opens a fresh session, or undefined when it resumes the one it has (or is not a home's). */
export const homeRolloverOf = (basis: RolloverBasis): FreshStartWhy | undefined => {
    if (!basis.home) {
        return undefined;
    }
    if (basis.pending !== undefined) {
        return basis.pending;
    }
    if (basis.sessionId === undefined || basis.continuing || basis.budget <= 0 || basis.contextTokens === undefined) {
        return undefined;
    }
    if (basis.contextTokens >= basis.budget) {
        return "budget";
    }
    return basis.contextTokens >= basis.budget / 2 && cold(basis.promptCache, basis.now) ? "cold" : undefined;
};

/** A home turn's fresh start, as the turn's preflight carries it out. */
export interface HomeRollover {
    readonly why: FreshStartWhy;
    // The context the old session had grown to, where a turn measured it.
    readonly from: number | undefined;
}

/**
 * Whether this turn of a home conversation starts fresh, and how: undefined for any other conversation, and for a turn
 * a held turn's own hand-off already decides (`way`). Clears a pending ask as it takes it, so it is taken once.
 */
export const homeRolloverFor = async (
    services: Pick<Services, "agents" | "sandboxSettings" | "logger">,
    input: RoutedTurn,
    basis: { readonly contextTokens: number | undefined; readonly promptCache: RolloverBasis["promptCache"] } | undefined,
    handedOff: boolean,
): Promise<HomeRollover | undefined> => {
    if (handedOff || input.conversationId === undefined) {
        return undefined;
    }
    const entry = services.agents.entry(input.conversationId);
    if (entry?.identity.home !== true) {
        return undefined;
    }
    const settings = await services.sandboxSettings.get();
    const why = homeRolloverOf({
        home: true,
        pending: entry.freshPending,
        sessionId: input.sessionId,
        continuing: input.resume !== undefined || input.forkOf !== undefined || input.resumeAt !== undefined,
        contextTokens: basis?.contextTokens,
        promptCache: basis?.promptCache,
        budget: settings.homeFreshOver,
        now: Date.now(),
    });
    if (why === undefined) {
        return undefined;
    }
    if (entry.freshPending !== undefined) {
        try {
            await services.agents.setFreshPending(input.conversationId, undefined);
        } catch (error) {
            services.logger.warn({ err: error, conversationId: input.conversationId }, "home: the fresh start it asked for could not be marked taken");
        }
    }
    return { why, from: why === "asked" || why === "cleared" ? undefined : basis?.contextTokens };
};

/** What the summarising model is told to write for a home's fresh session (limit-handoff.ts summaryNote). */
export const HOME_SUMMARY_INSTRUCTIONS = `You are writing the hand-off for a person's home conversation: one long-running chat in which an orchestrating agent delegates work to subagents, judges what comes back, and lands what it accepts. It has grown too large to keep re-reading, so a new session, with none of this conversation in its context, will continue from your summary, the latest messages, and a list of its subagents and what each holds. It can read the repository, so code need not be copied; what it cannot recover is what was said, decided and learned.

Write these sections, dense and specific (exact paths, names, ids, numbers, and the person's own words where they matter):
1. The person: how they like to work, their standing preferences, and every correction they gave.
2. Their requests: each one, done or not, and what came of it.
3. Decisions and their reasons, and approaches rejected (with why).
4. Delegated work: each subagent by id and title, what it was asked, how its work was judged (reviews, tests, what they found), and whether it was merged, landed, sent back, or is still running.
5. Open threads: what is still to do, what waits on the person, and anything promised.
6. The latest exchange: what was being done right before this point, quoting the latest instruction verbatim.

Output only the summary.`;

export const HOME_WORK_NOTE_TITLE = "Your subagents and where their work stands";

// How many of a home's subagents the note names, newest first: the work in hand, not its history.
const WORK_NOTE_KEPT = 30;

const stageWords = (status: AgentSummary["status"]): string => {
    switch (status) {
        case "running":
        case "resuming":
        case "stopping":
        case "landing":
            return "working";
        case "ready":
            return "finished, its work held on its branch for you to judge and merge";
        case "landed":
            return "merged";
        case "conflict":
            return "finished, its work clashes with yours: held";
        case "error":
            return "its last turn failed";
        case "awaiting":
            return "waiting on an answer";
        default:
            return status;
    }
};

const kindWords = (agent: AgentSummary): string => (agent.fresh === undefined ? "" : agent.fresh.kind === "review" ? " (review)" : agent.fresh.kind === "test" ? " (test)" : "");

/**
 * The subagents a home started, and where each one's work stands: what a fresh session cannot remember starting, and
 * acts on by id. Undefined when it started none, or none is still on the board.
 */
export const homeWorkNote = (services: Pick<Services, "agents">, homeId: string): TurnNote | undefined => {
    const started = services.agents
        .list()
        .filter((agent) => agent.archivedAt === undefined && (parentOfActor(agent.startedBy) === homeId || agent.fresh?.by === homeId))
        .toSorted((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, WORK_NOTE_KEPT);
    if (started.length === 0) {
        return undefined;
    }
    const lines = started.map((agent) => `- ${agent.id}${kindWords(agent)} · ${agent.title ?? "untitled"} · ${stageWords(agent.status)}`);
    return {
        title: HOME_WORK_NOTE_TITLE,
        text: `This session opened fresh, so the subagents you started earlier are listed here rather than remembered, newest first. Act on them by id as before (wait, send, answer, merge).\n${lines.join("\n")}`,
    };
};
