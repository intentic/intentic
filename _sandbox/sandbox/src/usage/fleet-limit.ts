import { type AccountUsage, gatingWindows, type ModelRef, type UsageWindow } from "@intentic/sandbox-contract";

/* WHAT THE RECORDED QUOTA SAYS ABOUT A PROVIDER'S FLEET FOR ONE MODEL, the single rule behind every daemon
 * decision that used to have its own: which routed turn's refusal names a reset (translator.ts turnLimit),
 * which quick-model rung is stepped over (quick-model-quota.ts), and whether an agent-run pin is worth
 * spending a session on (agent-run-model.ts). Three facts rather than one instant, because they call for
 * different things next.
 *
 * `withHeadroom` is the fact a single reset could not carry, and the one that changes what a refusal means:
 * CLIProxyAPI balances across every auth file it holds, so a routed refusal is fleet-wide by construction. If
 * an account still has room in the pool this model spends, the quota is NOT what refused the turn, the
 * translator had every credential cooling for some other reason (a transient upstream error cools a credential
 * for a minute), and naming a weekly reset would send the user away for days over a condition that clears in
 * seconds.
 *
 * SCOPED TO THE POOLS THE MODEL SPENDS (UsageWindow.gates, read through gatingWindows). Google meters Gemini
 * and the Claude/GPT models as separate weekly allowances off one sign-in; the earliest exhausted window across
 * every account and every pool answered a Claude Opus turn with the Gemini pool's instant, on an account that
 * was not serving it, while another account still had room in the pool the turn was really spending. An
 * account counts as spent when ANY pool this model draws on is spent, it is gated by its tightest, and for an
 * undivided plan (Codex, Kimi: every window gates every model) a spent 5-hour throttle stops a turn the weekly
 * pool would have allowed.
 *
 * Both counts zero ⇒ nothing on file measures this pool at all (never polled, a renamed bucket, a model the
 * plan publishes no pool for), which is a third state and reads as one: the caller says a limit was hit and
 * claims nothing about the fleet. */

export interface FleetReading {
    readonly account: string;
    readonly usage: AccountUsage | undefined;
    /* The translator's own bench (TranslatorAccount.cooling): a credential CLIProxyAPI is routing around right
     * now, whatever its last quota reading says. Counted as spent, with the proxy's retry instant as its reset,
     * because it is the more current of the two facts and the one that decides whether a turn can run. */
    readonly cooling?: { readonly until?: number | undefined; readonly reason?: string | undefined } | undefined;
}

export interface TurnLimit {
    // The exhausted pool's own name, as the subject of a sentence. Absent when the plan sells one undivided
    // allowance (every window gates every model), so there is no pool to name.
    readonly pool?: string;
    readonly spent: number;
    readonly withHeadroom: number;
    // When the earliest spent account reopens. Only ever set when nothing has headroom: with headroom on file
    // the pool is not the blocker, and there is no reset that answers "when can I send this again".
    readonly reopensAt?: number;
    // The newest reading among the accounts with headroom, epoch MS. What lets a memo of a refusal yield to a
    // reading taken since: a reading older than the refusal it is asked to contradict says nothing.
    readonly roomMeasuredAt?: number;
}

// Utilization at or past which the daemon treats a pool as spent. 100, not the browser's 90: the browser is
// steering a person away from a long turn, the daemon is deciding whether a call is certain to be refused.
export const SPENT_UTILIZATION = 100;

// One spent thing, with the instant it reopens where one is known, and the pool to name where there is one.
interface Exhausted {
    readonly resetsAt: number | undefined;
    readonly pool: string | undefined;
}

// A pool worth naming is one the plan scopes: the undivided 5-hour or weekly allowance is just "the
// allowance", and saying "Weekly · all models allowance" tells the reader nothing.
const exhaustedPool = (window: UsageWindow): Exhausted => ({ resetsAt: window.resetsAt, pool: window.gates === "all" ? undefined : window.label });

// The exhausted entry whose reset is soonest, since any one account reopening unblocks the turn. An entry with
// no instant is only the answer when nothing names one.
const soonestOf = (exhausted: readonly Exhausted[]): Exhausted | undefined =>
    exhausted.reduce<Exhausted | undefined>(
        (best, entry) =>
            best === undefined || (entry.resetsAt !== undefined && (best.resetsAt === undefined || entry.resetsAt < best.resetsAt)) ? entry : best,
        undefined,
    );

// One account's verdict for the model: nothing on file, room left (with when that was measured), or spent
// (with every full pool). Kept as a value so the tally below is a fold rather than a branch per case.
type Verdict = { readonly kind: "unmeasured" } | { readonly kind: "room"; readonly measuredAt: number } | { readonly kind: "spent"; readonly exhausted: readonly Exhausted[] };

const judge = (reading: FleetReading, model: ModelRef | undefined): Verdict => {
    if (reading.cooling !== undefined) {
        return { kind: "spent", exhausted: [{ resetsAt: reading.cooling.until, pool: undefined }] };
    }
    const windows = gatingWindows(reading.usage, model);
    if (windows.length === 0) {
        return { kind: "unmeasured" };
    }
    const full = windows.filter((window) => window.utilization >= SPENT_UTILIZATION);
    return full.length === 0 ? { kind: "room", measuredAt: reading.usage?.measuredAt ?? 0 } : { kind: "spent", exhausted: full.map(exhaustedPool) };
};

export const fleetLimit = (readings: readonly FleetReading[], model: ModelRef | undefined): TurnLimit => {
    const verdicts = readings.map((reading) => judge(reading, model));
    const room = verdicts.flatMap((verdict) => (verdict.kind === "room" ? [verdict.measuredAt] : []));
    const exhausted = verdicts.flatMap((verdict) => (verdict.kind === "spent" ? verdict.exhausted : []));
    const spent = verdicts.filter((verdict) => verdict.kind === "spent").length;
    const soonest = soonestOf(exhausted);
    return {
        ...(soonest?.pool === undefined ? {} : { pool: soonest.pool }),
        spent,
        withHeadroom: room.length,
        ...(room.length > 0 || soonest?.resetsAt === undefined ? {} : { reopensAt: soonest.resetsAt }),
        ...(room.length === 0 ? {} : { roomMeasuredAt: Math.max(...room) }),
    };
};
