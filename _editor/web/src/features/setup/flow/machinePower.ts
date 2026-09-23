import type { HostedStatus } from "@intentic/api-contract";
import { machineIsDown, type WakeRefusal } from "../hostedWait";

// What the provider has said about the hosted machine while somebody waits on it, and the starts this page has spent on
// one down episode, as one value only `stepPower` moves: a machine down under a waiting reader is started here, a
// bounded number of times, and the platform's refusal of such a start is kept as the true account of why it is down.

// Starts spent on one down episode: a machine that will not stay up must reach a verdict rather than be restarted
// forever on hours its owner is charged for.
export const MAX_WAKES = 3;
// Gap between two starts (ms), so a reading that lands mid-start never buys a second one.
export const WAKE_THROTTLE_MS = 30_000;

type Reading = HostedStatus[`machine`];

export interface MachinePower {
    readonly reading: Reading | undefined;
    // When the provider first reported the machine down (ms); any other reading clears it, so only a state that
    // survives several polls can become a verdict (hostedWait.ts).
    readonly downSince: number | undefined;
    // A start this page asked for is in flight; the wait card says nothing about the machine meanwhile.
    readonly waking: boolean;
    readonly wakes: number;
    // When the last start left (ms).
    readonly lastWakeAt: number;
    readonly refusal: WakeRefusal | undefined;
}

export type PowerEvent =
    // One provider reading at `at` (ms); a read that failed (undefined) establishes nothing.
    | { readonly kind: `read`; readonly reading: Reading | undefined; readonly at: number }
    | { readonly kind: `wake`; readonly at: number }
    // The platform took the start at `at` (ms), so the machine is starting because this page started it.
    | { readonly kind: `woke`; readonly at: number }
    | { readonly kind: `refused`; readonly refusal: WakeRefusal }
    // The start answered, either way.
    | { readonly kind: `settled` }
    // A new machine is expected: what was said about the old one no longer describes it.
    | { readonly kind: `forgot` }
    // The reader started it over: a new episode with its own allowance.
    | { readonly kind: `restarted` };

export const UNREAD: MachinePower = { reading: undefined, downSince: undefined, waking: false, wakes: 0, lastWakeAt: 0, refusal: undefined };

// The one place a reading is recorded, so the down clock can never drift from the state it times.
const noted = (power: MachinePower, reading: Reading | undefined, at: number): MachinePower => ({
    ...power,
    reading,
    downSince: machineIsDown(reading) ? (power.downSince ?? at) : undefined,
});

type Moves = { readonly [K in PowerEvent["kind"]]: (power: MachinePower, event: Extract<PowerEvent, { kind: K }>) => MachinePower };

const MOVES: Moves = {
    read: (power, { reading, at }) => {
        if (reading === undefined) {
            return power;
        }
        // Up, from the provider itself: the episode is over, so the next stop gets its own allowance and no refusal
        // from this one clings to it.
        return machineIsDown(reading) ? noted(power, reading, at) : { ...noted(power, reading, at), wakes: 0, refusal: undefined };
    },
    wake: (power, { at }) => ({ ...power, waking: true, wakes: power.wakes + 1, lastWakeAt: at }),
    woke: (power, { at }) => noted(power, `starting`, at),
    refused: (power, { refusal }) => ({ ...power, refusal }),
    settled: (power) => ({ ...power, waking: false }),
    forgot: (power) => ({ ...power, reading: undefined, downSince: undefined }),
    restarted: (power) => ({ ...power, reading: undefined, downSince: undefined, wakes: 0, refusal: undefined }),
};

// The table is keyed by the event's own kind, so the entry read always takes the event it is handed.
export const stepPower = (power: MachinePower, event: PowerEvent): MachinePower =>
    (MOVES[event.kind] as (power: MachinePower, event: PowerEvent) => MachinePower)(power, event);

// Whether another start may leave at `at` (ms): none in flight, the episode's allowance not spent, and the last one
// long enough ago.
export const wakeDue = (power: MachinePower, at: number): boolean =>
    !power.waking && power.wakes < MAX_WAKES && at - power.lastWakeAt >= WAKE_THROTTLE_MS;

// The platform refusing to start a machine at all, in the two shapes it does (api sandbox.wake): spent free hours, and
// an account whose hosted lane is switched off. Anything else is a bad minute, not a decision.
export const wakeRefusalOf = (err: unknown): WakeRefusal | undefined => {
    if (!err || typeof err !== `object`) {
        return undefined;
    }
    const { code, status } = err as { code?: unknown; status?: unknown };
    if (code === `PAYMENT_REQUIRED` || status === 402) {
        return `hours`;
    }
    return code === `FORBIDDEN` || status === 403 ? `suspended` : undefined;
};
