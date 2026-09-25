import { type AgentProvider, KeyedProviderSchema, type TurnProof } from "@intentic/sandbox-contract";
import type { Services } from "../../../composition.js";
import type { TurnPlacement } from "../../../agents/worktrees/isolation.js";
import type { RefreshOptions } from "../../../usage/headroom.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import { ERROR_MESSAGE_CHARS } from "../frames/classify-failure.js";
import type { Attribution } from "../frames/frame-decorators.js";
import type { TurnActivity } from "../frames/frame-effects.js";
import type { TurnFailure, TurnFrames } from "../frames/frame-reducers.js";
import { opt } from "../../../opt.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import type { TurnPlan } from "../turn/turn-plan.js";
import type { UsageFrame } from "../turn/turn-usage.js";
import type { HeldTurn } from "../turn/turn-resume.js";

// What a finished turn leaves behind, decided as data from its readings: the records a held turn is re-run from, the
// row that closes it in the activity log, its ledger row, the re-read it owes, and what its card records of the proof it
// showed. Nothing here sends the turn back: checks run after the work lands. settle-turn.ts carries it out.

// How much of the check that spoke the ledger keeps; a command is a line, not a script.
const VERIFICATION_CHECK_CHARS = 200;

// How fresh a reading must be before a settled turn re-reads it; a fleet costs one sweep.
const SETTLE_MAX_AGE_MS = 10_000;

export type TurnOutcome = "ok" | "error" | "cancelled";

// A held turn, proof the run got somewhere (which resets the stop ladder), or nothing without a conversation.
export type TurnHold =
    { readonly kind: "held"; readonly held: HeldTurn } | { readonly kind: "got-somewhere"; readonly conversationId: string } | undefined;

// What a conversation's card records of the turn that just ended: the proof it showed of its own work, read off its
// tool calls. Absent for a turn that touched no code and looked at nothing, which leaves the card's last record standing,
// since the work on the branch has not changed; and for a spawned child, whose parent's report carries its proof.
export interface ProofNote {
    readonly conversationId: string;
    readonly proof: TurnProof;
}

// A ledger row as the store is handed it; the store stamps the instant and the day.
type UsageRow = Parameters<Services["usage"]["record"]>[0];

export interface SettlementPlan {
    readonly hold: TurnHold;
    readonly completion: TurnActivity;
    // A routed turn's files are re-read, since it never learns which auth file served it.
    readonly headroomRefresh: RefreshOptions | undefined;
    // The durable ledger row every turn lands on, unbilled failures included.
    readonly usage: UsageRow;
    readonly proof: ProofNote | undefined;
    // The label of the main tree's turn-end snapshot; undefined for an isolated turn, which never touches it.
    readonly snapshot: string | undefined;
}

// How the turn ended, as far as settling it goes.
export interface TurnEnd {
    readonly input: TurnInput;
    readonly provider: AgentProvider;
    readonly attribution: Attribution;
    // The request the runtime was handed: its resolved model.
    readonly request: AgentRequest;
    readonly aborted: boolean;
    readonly isolated: boolean;
    // A spawned child's proof is its parent's report to carry, not a card of its own.
    readonly spawnedChild: boolean;
    // The namespace the turn ran in, if it entered one.
    readonly isolation: TurnPlacement | undefined;
    readonly experiments: Extract<TurnPlan, { readonly ok: true }>["experiments"];
    readonly frames: Pick<TurnFrames, "readings" | "verification" | "viewing" | "metrics">;
}

// Nothing held on a conversation is the run getting somewhere, the one thing that puts the stop ladder back at its start.
const holdOf = (end: TurnEnd): TurnHold => {
    const { held } = end.frames.readings();
    if (held !== undefined) {
        return { kind: "held", held };
    }
    return end.input.conversationId === undefined ? undefined : { kind: "got-somewhere", conversationId: end.input.conversationId };
};

// How the turn ended beyond its outcome, gated on the provider speaking rather than on being billed.
const endingOf = (
    end: TurnEnd,
): Pick<
    UsageRow,
    "verification" | "check" | "filesEdited" | "toolCalls" | "compactions" | "checklistTotal" | "checklistOpen" | "contextTokens" | "contextWindow"
> => {
    const { silence, checklist, compactions, context } = end.frames.readings();
    if (!silence.answered) {
        return {};
    }
    const proven = end.frames.verification.standing();
    return {
        verification: proven.state,
        ...(proven.check !== undefined ? { check: proven.check.slice(0, VERIFICATION_CHECK_CHARS) } : {}),
        filesEdited: end.frames.verification.edited().length,
        // Recorded on every turn, not just the quiet ones: zero is only legible beside the turns that acted.
        toolCalls: end.frames.metrics.calls(),
        compactions,
        ...(checklist !== undefined
            ? {
                  checklistTotal: checklist.length,
                  // Pending and in-progress both count as work started but not finished.
                  checklistOpen: checklist.filter((item) => item.status !== "completed").length,
              }
            : {}),
        ...(context !== undefined ? { contextTokens: context.tokens, contextWindow: context.contextWindow } : {}),
    };
};

// The ledger's own name for each model: what ran, and what was asked for when a pick was made. Empty is no pick: the
// wire allows `model: ""`, the catalog default.
const modelsOf = (end: TurnEnd): Pick<UsageRow, "model" | "modelRequested"> => ({
    ...opt("model", end.request.spec.model),
    ...(end.input.model !== undefined && end.input.model !== "" ? { modelRequested: end.input.model } : {}),
});

const failureOf = (failure: TurnFailure | undefined): Pick<UsageRow, "errorCode" | "errorMessage"> =>
    failure === undefined ? {} : { ...opt("errorCode", failure.code), errorMessage: failure.message.slice(0, ERROR_MESSAGE_CHARS) };

// What the turn cost, zero where the provider billed nothing; a billed turn with no count of its own is one turn.
export const costOf = (
    usage: UsageFrame | undefined,
): Pick<
    UsageRow,
    | "turns"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheCreationTokens"
    | "costUsd"
    | "durationMs"
    | "openingCacheReadTokens"
    | "openingCacheCreationTokens"
    | "promptFingerprint"
> => {
    const bill = usage ?? { kind: "usage" };
    return {
        turns: bill.numTurns ?? (usage === undefined ? 0 : 1),
        inputTokens: counted(bill.inputTokens),
        outputTokens: counted(bill.outputTokens),
        cacheReadTokens: counted(bill.cacheReadTokens),
        cacheCreationTokens: counted(bill.cacheCreationTokens),
        costUsd: counted(bill.costUsd),
        durationMs: counted(bill.durationMs),
        ...opt("openingCacheReadTokens", bill.openingCacheReadTokens),
        ...opt("openingCacheCreationTokens", bill.openingCacheCreationTokens),
        ...opt("promptFingerprint", bill.promptFingerprint),
    };
};

const counted = (value: number | undefined): number => value ?? 0;

const usageOf = (end: TurnEnd, outcome: TurnOutcome): UsageRow => {
    const { input } = end;
    const { usage, failure } = end.frames.readings();
    return {
        provider: end.provider,
        ...end.attribution,
        ...modelsOf(end),
        harness: input.harness ?? "native",
        outcome,
        ...failureOf(failure),
        ...opt("conversationId", input.conversationId),
        ...costOf(usage),
        // How it ended, past its cost: what changed, what proved it, what's left open.
        ...endingOf(end),
        ...(usage === undefined ? {} : end.frames.metrics.reading(end.frames.verification.edited())),
        // Every reading planning took, spread whole and already under the ledger's own field names: a stamp reaches the
        // row by existing, never by being named a second time here.
        ...end.experiments,
        // Marked on the turn the Auto judge picked for alone; undefined drops on the way out, so an ordinary turn
        // carries no field rather than a false one.
        autoPicked: input.autoPicked,
    };
};

// The proof the turn showed, for its card: whether a check it ran passed after its last edit to code, and how many
// rendered files it changed without looking at them since. A turn that touched no code and left no surface unlooked
// says nothing new about the branch, so it records nothing and the last record stands.
const proofOf = (end: TurnEnd, now: number): ProofNote | undefined => {
    const conversationId = end.input.conversationId;
    if (conversationId === undefined || end.spawnedChild || !end.frames.readings().silence.answered) {
        return undefined;
    }
    const proven = end.frames.verification.standing();
    const unviewed = end.frames.viewing.verdict()?.paths.length ?? 0;
    if (proven.state === "no-code" && unviewed === 0) {
        return undefined;
    }
    return {
        conversationId,
        proof: {
            at: now,
            verification: proven.state,
            ...(proven.check !== undefined ? { check: proven.check.slice(0, VERIFICATION_CHECK_CHARS) } : {}),
            ...(unviewed > 0 ? { unviewed } : {}),
        },
    };
};

const outcomeOf = (end: TurnEnd): TurnOutcome => {
    if (end.aborted) {
        return "cancelled";
    }
    return end.frames.readings().failure === undefined ? "ok" : "error";
};

export const settleTurn = (end: TurnEnd): SettlementPlan => {
    const outcome = outcomeOf(end);
    const { kind: _kind, ...billed } = end.frames.readings().usage ?? { kind: "usage" };
    const routed = KeyedProviderSchema.safeParse(end.provider).success;
    return {
        hold: holdOf(end),
        completion: { type: "turn.completed", ...(end.frames.readings().usage === undefined ? {} : { extra: billed }) },
        headroomRefresh: routed ? { scope: { providers: [end.provider] }, maxAgeMs: SETTLE_MAX_AGE_MS } : undefined,
        usage: usageOf(end, outcome),
        proof: proofOf(end, Date.now()),
        snapshot: end.isolated ? undefined : end.input.prompt,
    };
};
