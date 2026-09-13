import type { StatusVariant } from "@intentic/ui";
import { isBlocked, type ConnectionState } from "../live/connection";

// `reachable` is the exact request-layer answer (may a daemon call be made now); this projection is the calmer UI
// answer (no workspace yet, warming, briefly stale, or a wait long enough to explain). Keeps every surface from
// inventing its own offline threshold.

// Added on top of the watchdog's own liveness allowance, so ordinary stalls don't read as an outage.
export const SANDBOX_BUSY_AFTER_MS = 30_000;

// How long a sandbox the edge says is not dialled in is still given the benefit of the doubt: a container that
// restarts is detached for a few seconds. Lives here rather than in the gate because the gate's words and this
// projection's dot must change their mind at the same moment, or the switcher and the card disagree on screen.
export const DETACHED_AFTER_MS = 20_000;

export type SandboxAvailability = "starting" | "warming" | "live" | "stale" | "busy" | "detached" | "removed" | "blocked";

export interface SandboxAvailabilityVisual {
    readonly label: string;
    readonly variant: StatusVariant;
    readonly dotClass: string;
}

// One label/color per state; `stale` deliberately reads as live, since a retry shorter than the busy threshold
// shouldn't be visible.
export const sandboxAvailabilityVisual = (availability: SandboxAvailability): SandboxAvailabilityVisual => {
    switch (availability) {
        case "live":
        case "stale":
            return { label: "online", variant: "success", dotClass: "bg-success" };
        case "busy":
            return { label: "busy, catching up", variant: "neutral", dotClass: "bg-info" };
        case "warming":
        case "starting":
            return { label: "starting", variant: "neutral", dotClass: "bg-subtle" };
        // Off, not broken: its machine is asleep or its container is stopped, and it says so rather than pretending
        // to be on its way up, which is what "starting" did for as long as anyone left the tab open.
        case "detached":
            return { label: "not connected", variant: "neutral", dotClass: "bg-subtle" };
        case "removed":
            return { label: "removed", variant: "warning", dotClass: "bg-warning" };
        case "blocked":
            return { label: "needs attention", variant: "warning", dotClass: "bg-warning" };
    }
};

// How long the current run of failures has lasted; 0 whenever nothing has failed.
const outageMs = (state: ConnectionState, now: number): number => (state.unavailableSince === undefined ? 0 : now - state.unavailableSince);

// The endings no amount of waiting alters, in the order they outrank each other. `removed` is a reported fact (the
// machine that deleted the container said so) or the platform's own 404; never an inference from silence.
const settledAvailability = (state: ConnectionState, removed: boolean): SandboxAvailability | undefined => {
    if (removed || state.failure?.kind === `gone`) {
        return `removed`;
    }
    return state.failure !== undefined && isBlocked(state.failure) ? `blocked` : undefined;
};

export const sandboxAvailability = (state: ConnectionState, ready: boolean, established: boolean, now: number, removed = false): SandboxAvailability => {
    const settled = settledAvailability(state, removed);
    if (settled !== undefined) {
        return settled;
    }
    if (state.phase === `online`) {
        return ready ? `live` : `warming`;
    }
    // Ahead of `starting`: a sandbox that never painted and is not dialled in is not starting, and saying so was the
    // difference between a dot that resolves and one that spins for as long as the tab is open.
    if (state.failure?.kind === `detached` && outageMs(state, now) >= DETACHED_AFTER_MS) {
        return `detached`;
    }
    if (!established) {
        return `starting`;
    }
    return outageMs(state, now) >= SANDBOX_BUSY_AFTER_MS ? `busy` : `stale`;
};

// Blocks only when nothing can be painted yet or the wait needs explaining; a still-warm reconnect can render a
// normal loading state instead. A removed sandbox gates whatever was painted before: a workspace kept on screen for
// files that no longer exist is worse than an empty one.
export const sandboxRequiresGate = (reachable: boolean, established: boolean, availability: SandboxAvailability): boolean =>
    availability === `blocked` || availability === `removed` || (!reachable && !established);
