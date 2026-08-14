import type { ListenerStatus } from "@intentic/sandbox-contract";

// Push-based listener status: an extension's gateway process POSTs its live connection/voice snapshot to
// /listeners/<provider>/status, and the activity route reads it here — the daemon holds no provider connection
// of its own to probe. The schema lives in the contract (listener-protocol.ts) so the gateways type the
// snapshot they POST against the declaration this module parses with.

// A module singleton (like listeners' batchers) with a TTL, so a crashed or stopped gateway ages out to "no
// status" instead of showing a stale "connected"; the reconcile cadence is ~30s, so 90s is three missed posts.
const STATUS_TTL_MS = 90_000;
const statuses = new Map<string, { status: ListenerStatus; at: number }>();

export const setListenerStatus = (provider: string, status: ListenerStatus, now: number): void => {
    statuses.set(provider, { status, at: now });
};

// The latest status a provider's gateway posted, or undefined when none arrived within the TTL (never posted,
// or the gateway went quiet).
export const listenerStatus = (provider: string, now: number): ListenerStatus | undefined => {
    const entry = statuses.get(provider);
    if (entry === undefined || now - entry.at > STATUS_TTL_MS) {
        return undefined;
    }
    return entry.status;
};
