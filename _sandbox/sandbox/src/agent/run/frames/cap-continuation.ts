import type { Services } from "../../../composition.js";
import type { ErrorFrame } from "./classify-failure.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { isSpawnedChild } from "../../subagents/children.js";
import { carryOnTurn } from "../turn/turn-resume.js";
import { CAP_WHILE_ACTIVE } from "./cap-words.js";

/* A TURN THAT REACHES ITS CAP STILL WORKING CARRIES ON BY ITSELF. A vendor loop's hard cap (TurnSpec.turnCapMs, 30
   minutes by default) ends a turn however busy it is, coded `turn-cap`, which holds nothing: the next move was the
   owner's. Five times in four OpenCode conversations from 2026-10-30 to 11-02 the cap ended a turn whose last event had
   come one to four seconds before, and the owner typed "Continue" each time, up to 40 minutes later. Now such a turn goes
   on in a fresh turn of the same session, the Continue a person presses (carryOnTurn), once the capped one has settled,
   at most MAX_CAP_CONTINUATIONS times in a row; past that the owner is told the next move is theirs. A turn the cap
   ended after the loop had gone quiet is a stuck turn, not a busy one, and is left as it was. A spawned child is its
   parent's to carry on (children.ts), never this. */

/** Whether a failure frame is the watchdog's own cap, reached while the loop was still sending events. */
const capReachedWhileActive = (frame: Pick<ErrorFrame, "code" | "message" | "own">): boolean =>
    // allow(dependency-text): the words are the daemon's own (CAP_WHILE_ACTIVE, said by the watchdog's expiry) inside the loop's sentence; one that does not match reads as a quiet cap, left for the owner as before
    frame.code === "turn-cap" && frame.own === true && frame.message.includes(CAP_WHILE_ACTIVE);

// How many fresh turns in a row a busy conversation carries on into by itself: six caps of the default 30 minutes is
// three and a half hours of work with nobody pressing anything.
export const MAX_CAP_CONTINUATIONS = 6;

// The run each conversation's last continuation started, and how many in a row it was: a cap on that very run counts on
// from it, any other starts again at one. Kept in memory: a restart begins the count again, still bounded.
const chains = new Map<string, { readonly run: string; readonly count: number }>();

/** What the failure notice adds for a turn carried on (its place in the chain), or for one that stood down. */
export const capContinuationClause = (count: number): string =>
    count <= MAX_CAP_CONTINUATIONS
        ? `It was still working, so it carries on by itself in a fresh turn of the same session (${String(count)} of ${String(MAX_CAP_CONTINUATIONS)} in a row).`
        : `It was still working, but it has already carried on by itself ${String(MAX_CAP_CONTINUATIONS)} times in a row, so the next move is yours: press Continue to carry on.`;

// The capped turn's place in its chain: one more than the run it continued, else the first.
const placeInChain = (conversationId: string, run: string | undefined): number => {
    const chain = chains.get(conversationId);
    return chain !== undefined && run !== undefined && chain.run === run ? chain.count + 1 : 1;
};

/**
 * The capped turn's failure frame, told what happens next, and the continuation armed for once its run has settled.
 * Any other frame, a turn with no conversation or run, and a spawned child's turn come back as they were.
 */
export const continueCappedTurn = (
    services: Pick<Services, "agents" | "conversations" | "turns" | "events" | "logger">,
    frame: ErrorFrame,
    turn: { readonly input: RoutedTurn; readonly run: string | undefined },
): ErrorFrame => {
    const { conversationId } = turn.input;
    const { run } = turn;
    if (!capReachedWhileActive(frame) || conversationId === undefined || run === undefined || isSpawnedChild(services.conversations, conversationId)) {
        return frame;
    }
    const count = placeInChain(conversationId, run);
    if (count > MAX_CAP_CONTINUATIONS) {
        chains.delete(conversationId);
        services.logger.info({ conversationId, run, count }, "turn cap: carried on as often as it may in a row, the next move is the owner's");
        return { ...frame, message: `${frame.message} ${capContinuationClause(count)}` };
    }
    const carryOn = async (): Promise<void> => {
        try {
            const started = await carryOnTurn(services, { ...turn.input, conversationId, speaker: { kind: "sandbox", source: "turn-cap" } });
            if (started === undefined) {
                services.logger.info({ conversationId, run }, "turn cap: not carried on, another turn holds the conversation");
                return;
            }
            chains.set(conversationId, { run: started.id, count });
            services.logger.info({ conversationId, run, next: started.id, count }, "turn cap: the turn was still working, carried on in a fresh turn");
        } catch (error) {
            services.logger.warn({ err: error, conversationId, run }, "turn cap: could not carry the turn on");
        }
    };
    const unsubscribe = services.events.subscribe("run.settled", (settled) => {
        if (settled.conversationId === conversationId && settled.run === run) {
            unsubscribe();
            void carryOn();
        }
    });
    return { ...frame, message: `${frame.message} ${capContinuationClause(count)}` };
};
