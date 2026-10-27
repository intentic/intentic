import type { TurnNote,TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { FreshStart, HandedOff, HandoffMode } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../../../../composition.js";
import { HOME_SUMMARY_INSTRUCTIONS, type HomeRollover, homeRolloverFor, homeWorkNote } from "../../../../conversations/home/home-rollover.js";
import { roleModelIsSet } from "../../../models/role-model.js";
import type { RoutedTurn } from "../../../../seams/turn-starter.js";
import type { AgentExecutionContext } from "../../../../workload/agent-execution.js";
import { opt } from "../../../../opt.js";
import { summaryNote } from "../../../providers/limit-handoff.js";
import { type ColdTrimBasis, resumeTrimTurn } from "../cold-trim.js";
import type { TurnExperimentStamps } from "../turn-plan.js";
import { carriedHandoff, withoutSession } from "./handoff-way.js";
import type { HeldTurn } from "./held-turn.js";

// HOW A TURN GOES ON FROM WHAT CAME BEFORE IT, where that is more than resuming its session: a spent allowance's held
// turn carried, trimmed or summarised (holds/handoff-way.ts), a large cold session trimmed (cold-trim.ts), or a home
// conversation starting fresh (conversations/home/home-rollover.ts). Each is decided before the turn reaches the
// runtime's store; this is where the turn the store is asked about is cut, and what the fresh session it opens is told.

type Trimmed = Awaited<ReturnType<typeof resumeTrimTurn<RoutedTurn>>>;

/** A home's fresh start as this turn carries it out: why, and whether a model is set to write its summary. */
export type HomeContinuation = HomeRollover & { readonly summarize: boolean };

/** Whether this turn of a home starts fresh (home-rollover.ts), and whether a summary can be written for it. */
export const homeContinuationOf = async (
    services: Services,
    input: RoutedTurn,
    basis: ColdTrimBasis | undefined,
    handedOff: boolean,
): Promise<HomeContinuation | undefined> => {
    const rollover = await homeRolloverFor(services, input, basis, handedOff);
    return rollover === undefined ? undefined : { ...rollover, summarize: await roleModelIsSet(services, "handoff-summary") };
};

/** The copy of the session a turn resumes, written before the store is asked; a home starting fresh trims nothing. */
export const continuationTrim = (
    services: Services,
    input: RoutedTurn,
    settings: SandboxSettings,
    held: HeldTurn | undefined,
    basis: ColdTrimBasis | undefined,
    way: HandoffMode | undefined,
    rollover: HomeContinuation | undefined,
): Promise<Trimmed> =>
    rollover === undefined ? resumeTrimTurn(services, input, settings, held, basis, way) : Promise.resolve({ turn: input, event: undefined, stamps: {}, cold: false });

/** The turn as the store is asked about it: a summary opens a fresh session, and so does a home starting fresh. */
export const continuationInput = (turn: RoutedTurn, way: HandoffMode | undefined, rollover: HomeContinuation | undefined): RoutedTurn =>
    way === "summary" || rollover !== undefined ? withoutSession(turn) : turn;

export interface Continuation {
    // What a fresh session opens with beside the record: the summary, then a home's subagents.
    readonly notes: readonly TurnNote[];
    readonly handedOff: HandedOff | undefined;
    readonly freshStart: FreshStart | undefined;
    readonly stamps: TurnExperimentStamps;
}

/** What the session the turn opens is told of how it goes on, and the frame and ledger stamps that say so. */
export const continuationOf = async (
    services: Services,
    execution: AgentExecutionContext,
    params: {
        readonly input: RoutedTurn;
        readonly history: readonly TranscriptRow[];
        readonly held: HeldTurn | undefined;
        readonly way: HandoffMode | undefined;
        readonly rollover: HomeContinuation | undefined;
        readonly resumed: string | undefined;
        readonly delivery: Pick<Trimmed, "event" | "stamps">;
        readonly signal: AbortSignal | undefined;
    },
): Promise<Continuation> => {
    const { input, history, held, way, rollover, delivery } = params;
    const conversationId = input.conversationId;
    const summarized =
        (way === "summary" || rollover?.summarize === true) && history.length > 0 && conversationId !== undefined
            ? await summaryNote(services, execution, {
                  conversationId,
                  rows: history,
                  contextTokens: rollover?.from ?? held?.contextTokens,
                  signal: params.signal,
                  ...opt("instructions", rollover === undefined ? undefined : HOME_SUMMARY_INSTRUCTIONS),
              })
            : undefined;
    if (rollover === undefined) {
        return {
            notes: summarized?.note === undefined ? [] : [summarized.note],
            handedOff: delivery.event ?? summarized?.event ?? carriedHandoff(way, held, params.resumed),
            freshStart: undefined,
            stamps: delivery.stamps,
        };
    }
    // A home's fresh session cannot remember the subagents it started, which it goes on supervising by id.
    const work = conversationId === undefined ? undefined : homeWorkNote(services, conversationId);
    const written = summarized?.note;
    return {
        notes: [written, work].filter((note): note is TurnNote => note !== undefined),
        handedOff: undefined,
        freshStart: {
            why: rollover.why,
            ...opt("from", rollover.from),
            ...opt("model", written === undefined ? undefined : summarized?.event.model),
            summarized: written !== undefined,
        },
        stamps: { ...delivery.stamps, homeFresh: rollover.why },
    };
};
