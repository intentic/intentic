import type { BootProgress } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

/* WHERE THE ACTIVE DAEMON IS IN ITS OWN BOOT, from the /events hello + boot frames.
 *
 * The daemon listens before the state it serves has converged, deliberately, so a restart stops reading as an
 * outage (see the sandbox's main.ts). For those seconds it is reachable and unable to answer: /health and
 * /events reply at once while every data route parks on the readiness gate.
 *
 * The browser used to have no way to see that. A live stream meant `online`, `online` meant `reachable`, and a
 * workspace hydrated from the persisted cache painted itself fully operable over a daemon that would answer
 * nothing, so the first click went into the gate and stayed there. The only reliable escape was clearing site
 * data, which "worked" for a reason worth naming: with no persisted session the credential exchange parked
 * too, the stream never opened, and the user sat on the honest connecting screen instead.
 *
 * So readiness is a fact we now RECEIVE. `reachable` (useSandbox) is gated on it, which holds every daemon
 * query in one place, and the warm-up gate renders this progress while it waits.
 *
 * Module-level singleton, like useDaemonRoutes next door, and fed only by useSandboxLiveness. Undefined means
 * ASSUME READY, a daemon built before the frame cannot be interrogated, so nothing may be gated on its
 * silence; that is exactly the pre-existing behaviour. */

const progress = ref<BootProgress | undefined>(undefined);

// Called on every hello and boot frame. A daemon that says nothing leaves us in the assume-ready state.
export const setDaemonBoot = (reported: BootProgress | undefined): void => {
    progress.value = reported;
};

// A dropped connection tells us nothing about the daemon's boot, but a SWITCH to another sandbox does: the
// next hello re-reports. Cleared on switch so one sandbox's boot is never attributed to another.
export const resetDaemonBoot = (): void => {
    progress.value = undefined;
};

// Can the active daemon serve its data routes yet? Unknown daemons answer true (see the module note).
export const daemonReady = computed(() => progress.value?.ready !== false);

// The chain, for the warm-up gate to render. Empty whenever there is nothing to show.
export const bootSteps = computed(() => progress.value?.steps ?? []);

// When the daemon started converging, so the gate can show a total that survives a reconnect mid-boot.
export const bootStartedAt = computed(() => progress.value?.startedAt);
