import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { opt } from "../../../opt.js";
import { turnPulseOf } from "../turn/turn-pulse.js";
import type { TokenCounts } from "./burn-weight.js";
import { meterTokens } from "./token-meter.js";

/* WHAT A CLAUDE CODE STREAM SPENT, as its messages and its results say it (agent/run/sdk-stream.ts's accounting).

   The CLI hands every model message on with the request's usage, the in-process helpers' messages too, and may hand
   one message on more than once (once per content block, each carrying the usage as it then stood). Counted by message
   id, as the most each kind reached, so a message read twice is counted once and one whose output grew between two
   readings adds only the growth; each addition goes onto the live meter (token-meter.ts) as it arrives. A result
   reports the turn's own accounting, which is the usage frame the ledger is written from; what was counted since the
   last result is the spend no result reported. A stream the CLI ended on a spent allowance has no result at all, and
   ten children that had worked fifty minutes each were filed at no tokens that way (2026-10-20): its spend is said from
   here instead (`owedFrames`). */

/** One message's usage, as the Messages API names it. */
export interface MessageUsage {
    readonly input_tokens?: number | null;
    readonly output_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
}

/** A result's accounting, the fields of the SDK's result message it reads. */
export interface ResultAccounting {
    readonly usage?: MessageUsage | undefined;
    readonly total_cost_usd?: number | undefined;
    readonly duration_ms?: number | undefined;
    readonly num_turns?: number | undefined;
}

/** What the stream measured of its own first request and prompt, stamped on each result's frame. */
export interface ResultStamps {
    readonly opening?: { readonly read: number; readonly written: number } | undefined;
    readonly fingerprint?: string | undefined;
}

type Counted = { input: number; output: number; cacheRead: number; cacheWrite: number };

const zero = (): Counted => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const isEmpty = (counts: Counted): boolean => counts.input === 0 && counts.output === 0 && counts.cacheRead === 0 && counts.cacheWrite === 0;

const countedOf = (usage: MessageUsage): Counted => ({
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
});

const combined = (left: Counted, right: Counted, pick: (a: number, b: number) => number): Counted => ({
    input: pick(left.input, right.input),
    output: pick(left.output, right.output),
    cacheRead: pick(left.cacheRead, right.cacheRead),
    cacheWrite: pick(left.cacheWrite, right.cacheWrite),
});

export class MessageTally {
    // The most each message reached so far, by id.
    private readonly seen = new Map<string, Counted>();
    // What was counted since the last result reported its own accounting.
    private since: Counted = zero();
    // The query's running total as of the last result, in USD: the SDK reports that total, a frame only its growth.
    private spentUsd: number;

    // `conversationId` is whose meter the messages go on (none for a turn with no conversation); `carriedCostUsd` what a
    // resumed session already spent, which its first result counts again.
    constructor(
        private readonly conversationId: string | undefined,
        carriedCostUsd = 0,
    ) {
        this.spentUsd = carriedCostUsd;
    }

    /** A message's usage as it stands now; answers what it adds to what was already counted, or undefined for nothing new. */
    take(id: string | undefined, usage: MessageUsage | undefined): TokenCounts | undefined {
        if (usage === undefined) {
            return undefined;
        }
        const now = countedOf(usage);
        // A message with no id cannot be told from its own re-reading: counted once, as it comes.
        const before = id === undefined ? zero() : (this.seen.get(id) ?? zero());
        const added = combined(now, before, (current, earlier) => Math.max(0, current - earlier));
        if (id !== undefined) {
            this.seen.set(id, combined(now, before, Math.max));
        }
        if (isEmpty(added)) {
            return undefined;
        }
        this.since = combined(this.since, added, (sum, more) => sum + more);
        if (this.conversationId !== undefined) {
            meterTokens(turnPulseOf(this.conversationId), added);
        }
        return added;
    }

    /** A result's usage frame, where the SDK reported any: what was counted before it is that result's, not owed any more. */
    *resultFrames(message: ResultAccounting, stamps: ResultStamps = {}): Generator<AgentEvent> {
        // Only surface accounting when the SDK actually reported it; an empty frame on every turn would be noise.
        if (message.usage === undefined && message.total_cost_usd === undefined) {
            return;
        }
        this.since = zero();
        yield {
            kind: "usage",
            ...opt("costUsd", this.spentSince(message.total_cost_usd)),
            ...opt("inputTokens", message.usage?.input_tokens ?? undefined),
            ...opt("outputTokens", message.usage?.output_tokens ?? undefined),
            ...opt("cacheReadTokens", message.usage?.cache_read_input_tokens ?? undefined),
            ...opt("cacheCreationTokens", message.usage?.cache_creation_input_tokens ?? undefined),
            ...opt("durationMs", message.duration_ms),
            ...opt("numTurns", message.num_turns),
            ...opt("openingCacheReadTokens", stamps.opening?.read),
            ...opt("openingCacheCreationTokens", stamps.opening?.written),
            ...opt("promptFingerprint", stamps.fingerprint),
        };
    }

    /** What was counted since the last result, once, as a usage frame: the spend a stream that ended without one still owes. */
    *owedFrames(): Generator<AgentEvent> {
        const owed = this.since;
        this.since = zero();
        if (isEmpty(owed)) {
            return;
        }
        yield { kind: "usage", inputTokens: owed.input, outputTokens: owed.output, cacheReadTokens: owed.cacheRead, cacheCreationTokens: owed.cacheWrite };
    }

    // This result's own spend, off the running total the SDK reports: carried in from a resumed transcript, cumulative
    // across results. A total below the last means the count started over (a /clear, a zeroed crash result).
    private spentSince(total: number | undefined): number | undefined {
        if (total === undefined) {
            return undefined;
        }
        const previous = total < this.spentUsd ? 0 : this.spentUsd;
        this.spentUsd = total;
        return total - previous;
    }
}
