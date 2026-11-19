import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { newRowId } from "@intentic/sandbox-contract/ids/row-ids";
import { oneLine } from "@intentic/base/one-line";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { DomainEventMap } from "../seams/domain-events.js";
import type { StartedRun, TurnStarter } from "../seams/turn-starter.js";
import { isSpawnedChild } from "../agent/subagents/children.js";
import { conversationProfile, type PersistedAgent, worktreeOf } from "../conversations/registry/agents-store.js";
import { loopRunning } from "./loop-runner.js";

/* A TURN THAT STOPS BECAUSE ITS CONTEXT GREW LARGE, WITH WORK STILL OPEN, CARRIES ON IN A FRESH SESSION. Agents end a turn
   by themselves on a large context ("Steps 8-11 are still open. I stopped before them because this conversation's context
   is large. I'd continue in a fresh conversation"), and the owner typed the continuation by hand: in the 2026-11 audit of
   a game-dev sandbox, three such stops in a row each restarted within six minutes, and a chain sat idle overnight. A
   context-overflow failure is not this: the provider refused the turn, and it is held and re-run fresh on no policy
   (agent/run/frames/classify-failure.ts dressOverflow). This is the turn that ended clean saying so.

   Recognised from the stopped turn's own closing words (contextStopOf): one sentence that both says it stopped and names
   the context's size as why, said in its own voice, with work said to remain. What happens then is the sandbox's
   `contextContinues` setting: that many times in a row the conversation goes on by itself in a fresh session, which the
   daemon seeds from the record (the latest messages, where the work stands: agent/run/turn/turn-preflight-input.ts
   handoffOf) and this module's prompt (what the stopped turn said was left). Zero, the default, only says on the record
   that it could. A spawned child is its parent's to carry on, a loop's round its loop's, and a home starts fresh by its
   own budget (conversations/home/home-rollover.ts). */

/** Who the continuation's opening words are from, on its row and in the notice the record keeps. */
export const CONTEXT_CONTINUE_SOURCE = "context-continue";

// Sentences, cut where a reader would stop: a clause after a semicolon is a sentence of its own here.
const SENTENCE_BREAK = /[.!?;\n]+/u;
// Said it stopped, or that it is leaving the rest for another session.
const STOPPED =
    /\b(?:stop(?:ped|ping)?|paus(?:e|ed|ing)|halt(?:ed|ing)?|wrap(?:ping)? (?:up|it up)|hand(?:ing)?[- ]?off|leav(?:e|ing) (?:the rest|them|it|those)|(?:fresh|new|next) (?:session|conversation|chat|context|turn))\b/iu;
// The context's size as the reason: "this conversation's context is large", "given the long context", "context budget".
const SIZE =
    /\b(?:context|conversation|session|transcript)\b[^.;!?\n]{0,40}?\b(?:large|long|big|full|heavy|huge|bloated|limits?|window|budget)\b|\b(?:large|long|full|heavy|big|growing|bloated) (?:context|conversation)\b/iu;
// Its own voice: an agent describing a feature that stops turns on a full context is not stopping one.
const OWN_VOICE = /\b(?:I|I'm|I've|I'd|I'll|we|we're|we've|let's|my|me|here)\b/iu;
// Work said to remain, anywhere in the closing.
const REMAINING =
    /\b(?:remain(?:s|ing)?|still open|left (?:to do|open)|(?:is|are) left|unfinished|not (?:yet )?(?:done|started|finished)|next (?:steps?|items?|up)|open (?:items?|steps?)|pending|to-?do)\b/iu;

/** Whether a turn's closing words say it stopped because its context grew large while work remains. */
export const contextStopOf = (closing: string): boolean =>
    REMAINING.test(closing) &&
    closing.split(SENTENCE_BREAK).some((sentence) => STOPPED.test(sentence) && SIZE.test(sentence) && OWN_VOICE.test(sentence));

// How much of the stopped turn's closing words the fresh session is handed; the rest is in its seeded history.
const CLOSING_CHARS = 4_000;

/** Where a continuation stands in a run of them; absent for one somebody asked for (`agents continue`). */
export interface ContinuationPlace {
    readonly count: number;
    readonly max: number;
}

/** What the fresh session is told: why it opened, what the stopped turn said was left, and how many more may follow. */
export const continuationPrompt = (closing: string, place?: ContinuationPlace): string => {
    const said = closing.length > CLOSING_CHARS ? `…${closing.slice(-CLOSING_CHARS)}` : closing;
    const why =
        place === undefined
            ? `This conversation carries on in a fresh session, as somebody asked, so it no longer re-reads its whole earlier context.`
            : `This conversation's last turn stopped by itself because its context had grown large, with work still open, so the sandbox carries it on in a fresh session (continuation ${String(place.count)} of at most ${String(place.max)} in a row).`;
    return [
        `${why} Above are the latest messages and where the work stands; what was said before them is not, so trust the working tree and \`git log\` over memory, and do not redo finished work.`,
        ``,
        `What the last turn said as it ended:`,
        ``,
        said
            .split(`\n`)
            .map((line) => `> ${line}`)
            .join(`\n`),
        ``,
        `Carry on with what it said was left, in the order it gave. If your own context grows large before the work is done, stop the same way, saying what is still open${place === undefined ? `` : `, and the sandbox carries on again while continuations remain`}.`,
    ].join(`\n`);
};

/** What happens to a context stop: carried on (its place in the run of continuations), or only offered. */
export type ContextContinueDecision =
    | { readonly kind: "continue"; readonly count: number; readonly max: number }
    | { readonly kind: "offer" }
    | { readonly kind: "spent"; readonly max: number };

/** The decision for the `count`th context stop in a row under a setting of `max`. */
export const decideContextContinue = (count: number, max: number): ContextContinueDecision => {
    if (max <= 0) {
        return { kind: "offer" };
    }
    return count > max ? { kind: "spent", max } : { kind: "continue", count, max };
};

/** The record's line for a stop the sandbox did not carry on, saying what the owner can do about it. */
const contextStopNotice = (decision: Exclude<ContextContinueDecision, { kind: "continue" }>, conversationId: string): string =>
    decision.kind === "offer"
        ? `This turn stopped because its context had grown large, with work still open. The sandbox can carry stops like this on by itself in a fresh session: raise the \`contextContinues\` setting above 0. To carry this one on fresh now, ask any agent to run \`agents continue ${conversationId}\`.`
        : `This turn stopped because its context had grown large, with work still open, but the sandbox has already carried this conversation on ${String(decision.max)} times in a row (the \`contextContinues\` setting), so the next move is yours: send a message, or run \`agents continue ${conversationId}\` for a fresh session.`;

/** What the reaction reads and does, as plain doors over the daemon's services (contextContinueDeps). */
export interface ContextContinueDeps {
    readonly entryOf: (conversationId: string) => PersistedAgent | undefined;
    // Whether something else has the conversation's next move now: a turn running, words waiting, a loop, or a parent.
    readonly busy: (conversationId: string) => boolean;
    readonly start: TurnStarter["start"];
    readonly note: (conversationId: string, row: TranscriptRow) => Promise<void>;
    // The `contextContinues` setting, read at each stop.
    readonly allowed: () => Promise<number>;
    readonly logger: Pick<Logger, "info" | "warn">;
}

export const contextContinueDeps = (services: Pick<Services, "agents" | "conversations" | "turns" | "transcripts" | "sandboxSettings" | "logger">): ContextContinueDeps => ({
    entryOf: (conversationId) => services.agents.entry(conversationId),
    busy: (conversationId) =>
        services.conversations.running(conversationId) ||
        services.conversations.queued(conversationId).items.length > 0 ||
        loopRunning(services.conversations, conversationId) ||
        isSpawnedChild(services.conversations, conversationId),
    start: (turn, options) => services.turns.start(turn, options),
    note: (conversationId, row) => services.transcripts.append({ id: conversationId }, [row]),
    allowed: async () => (await services.sandboxSettings.get()).contextContinues,
    logger: services.logger,
});

// The run each conversation's last continuation started, and how many in a row it was: a stop on that very run counts on
// from it, any other run (a person's message, a wake) starts again at one. Kept in memory, like the turn cap's
// (agent/run/frames/cap-continuation.ts): a restart begins the count again, still bounded.
const chains = new Map<string, { readonly run: string; readonly count: number }>();

const placeInChain = (conversationId: string, run: string): number => {
    const chain = chains.get(conversationId);
    return chain?.run === run ? chain.count + 1 : 1;
};

/**
 * Starts a fresh session on the conversation, opened with what its last turn said as it stopped. Undefined when the
 * conversation cannot take a turn now (one runs, it is archived, or the start was refused).
 */
export const continueFresh = async (
    deps: Pick<ContextContinueDeps, "entryOf" | "start">,
    conversationId: string,
    closing: string,
    place?: ContinuationPlace,
): Promise<StartedRun | undefined> => {
    const entry = deps.entryOf(conversationId);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return undefined;
    }
    // No session named: the daemon opens a fresh one, seeded from the record (turn-preflight-input.ts handoffOf).
    const started = await deps.start({
        ...conversationProfile(entry),
        conversationId,
        prompt: continuationPrompt(closing, place),
        speaker: { kind: "sandbox", source: CONTEXT_CONTINUE_SOURCE },
    });
    return started === "busy" || started === "archived" ? undefined : started;
};

const noted = async (deps: ContextContinueDeps, conversationId: string, text: string): Promise<void> => {
    try {
        await deps.note(conversationId, { role: "notice", text, rowId: newRowId(), agentNotice: { level: "info", source: CONTEXT_CONTINUE_SOURCE } });
    } catch (error) {
        deps.logger.warn({ err: error, conversationId }, "context continue: the notice could not be recorded");
    }
};

// A run this reaction is for: ended clean on its own, on a conversation of its own with nothing else to go next.
const eligible = (deps: ContextContinueDeps, settled: DomainEventMap["run.settled"]): boolean => {
    const entry = deps.entryOf(settled.conversationId);
    return (
        settled.failure === undefined &&
        settled.stopped !== true &&
        settled.rerun === undefined &&
        entry !== undefined &&
        entry.archivedAt === undefined &&
        entry.identity.home !== true &&
        worktreeOf(entry)?.parent === undefined &&
        !deps.busy(settled.conversationId)
    );
};

/** One settled run, judged and acted on: carried on fresh, or the stop only noted with what the owner can do. */
export const onRunSettled = async (deps: ContextContinueDeps, settled: DomainEventMap["run.settled"]): Promise<ContextContinueDecision | undefined> => {
    if (!eligible(deps, settled) || !contextStopOf(settled.closing)) {
        return undefined;
    }
    const { conversationId, run } = settled;
    const decision = decideContextContinue(placeInChain(conversationId, run), await deps.allowed());
    deps.logger.info({ conversationId, run, decision: decision.kind, closing: oneLine(settled.closing, 160) }, "context continue: the turn stopped on a large context with work open");
    if (decision.kind !== "continue") {
        chains.delete(conversationId);
        await noted(deps, conversationId, contextStopNotice(decision, conversationId));
        return decision;
    }
    const started = await continueFresh(deps, conversationId, settled.closing, decision);
    if (started === undefined) {
        deps.logger.info({ conversationId, run }, "context continue: not carried on, the conversation could not take a turn");
        return undefined;
    }
    chains.set(conversationId, { run: started.id, count: decision.count });
    return decision;
};

/** Subscribes the reaction; composition.ts wireReactions calls it once. */
export const continueAfterContextStops = (services: Parameters<typeof contextContinueDeps>[0] & Pick<Services, "events">): (() => void) => {
    const deps = contextContinueDeps(services);
    return services.events.subscribe("run.settled", (settled) =>
        onRunSettled(deps, settled).catch((cause: unknown) =>
            deps.logger.warn({ err: cause, conversationId: settled.conversationId }, "context continue: the stop could not be acted on"),
        ),
    );
};
