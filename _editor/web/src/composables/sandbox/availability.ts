import type { StatusVariant } from "@intentic/ui";
import { isBlocked, type ConnectionState } from "./connection";

/* TRANSPORT TRUTH IS NOT PRESENTATION TRUTH.
 *
 * `reachable` remains the exact answer request code needs: may a daemon call be made now? This projection is
 * the calmer answer a person needs: is there no workspace yet, is the daemon warming, is a previously-painted
 * workspace briefly stale, or has the wait lasted long enough to deserve a quiet explanation? Keeping that
 * split here prevents every surface from inventing its own "offline" threshold. */

// The liveness watchdog has already allowed ten seconds of silence before a failure reaches this clock. Another
// thirty seconds keeps ordinary CPU/GC/build stalls invisible while still naming a wait that has become real.
export const SANDBOX_BUSY_AFTER_MS = 30_000;

export type SandboxAvailability = "starting" | "warming" | "live" | "stale" | "busy" | "blocked";

export interface SandboxAvailabilityVisual {
    readonly label: string;
    readonly variant: StatusVariant;
    readonly dotClass: string;
}

// One spelling and one colour vocabulary everywhere the active sandbox is summarized. `stale` deliberately
// looks live: a retry shorter than the busy threshold should cause no visible state change at all.
export const sandboxAvailabilityVisual = (availability: SandboxAvailability): SandboxAvailabilityVisual => {
    switch (availability) {
        case "live":
        case "stale":
            return { label: "Online", variant: "success", dotClass: "bg-success" };
        case "busy":
            return { label: "Busy, catching up", variant: "neutral", dotClass: "bg-info animate-pulse" };
        case "warming":
        case "starting":
            return { label: "Starting", variant: "neutral", dotClass: "bg-subtle" };
        case "blocked":
            return { label: "Needs attention", variant: "warning", dotClass: "bg-warning" };
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

// Blocking the whole workspace is reserved for a first paint that cannot begin, or a condition waiting cannot
// repair. A recovered transport may become reachable before its first tree response; that is a normal loading
// state inside the view, not a reason to keep showing the connection screen.
export const sandboxRequiresGate = (reachable: boolean, established: boolean, availability: SandboxAvailability): boolean =>
    availability === "blocked" || (!reachable && !established);
