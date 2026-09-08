import type { StatusVariant } from "@intentic/ui";
import { isBlocked, type ConnectionState } from "../live/connection";

// `reachable` is the exact request-layer answer (may a daemon call be made now); this projection is the calmer UI
// answer (no workspace yet, warming, briefly stale, or a wait long enough to explain). Keeps every surface from
// inventing its own offline threshold.

// Added on top of the watchdog's own liveness allowance, so ordinary stalls don't read as an outage.
export const SANDBOX_BUSY_AFTER_MS = 30_000;

export type SandboxAvailability = "starting" | "warming" | "live" | "stale" | "busy" | "blocked";

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
        case "blocked":
            return { label: "needs attention", variant: "warning", dotClass: "bg-warning" };
    }
};

export const sandboxAvailability = (state: ConnectionState, ready: boolean, established: boolean, now: number): SandboxAvailability => {
    if (state.failure !== undefined && isBlocked(state.failure)) {
        return "blocked";
    }
    if (state.phase === "online") {
        return ready ? "live" : "warming";
    }
    if (!established) {
        return "starting";
    }
    if (state.unavailableSince !== undefined && now - state.unavailableSince >= SANDBOX_BUSY_AFTER_MS) {
        return "busy";
    }
    return "stale";
};

// Blocks only when nothing can be painted yet or the wait needs explaining; a still-warm reconnect can render a
// normal loading state instead.
export const sandboxRequiresGate = (reachable: boolean, established: boolean, availability: SandboxAvailability): boolean =>
    availability === "blocked" || (!reachable && !established);
