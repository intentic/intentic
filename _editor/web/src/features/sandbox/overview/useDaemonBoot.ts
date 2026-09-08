import type { BootProgress } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";

// Where the active daemon is in its own boot (from the /events hello + boot frames). It answers /health and
// /events before data routes are ready, so a restart doesn't read as an outage; `reachable` (useSandbox) gates on
// this. Module singleton fed only by useSandboxLiveness; undefined means assume ready.

const progress = ref<BootProgress | undefined>(undefined);

// Called on every hello and boot frame; a daemon that says nothing leaves the state at assume-ready.
export const setDaemonBoot = (reported: BootProgress | undefined): void => {
    progress.value = reported;
};

// Cleared on a sandbox switch, not on a dropped connection alone, so one sandbox's boot isn't attributed to another.
export const resetDaemonBoot = (): void => {
    progress.value = undefined;
};

// Can the active daemon serve data routes yet; an unknown daemon answers true.
export const daemonReady = computed(() => progress.value?.ready !== false);

// Steps for the warm-up gate to render; empty when there's nothing to show.
export const bootSteps = computed(() => progress.value?.steps ?? []);

// When the daemon started converging, so the gate's total survives a reconnect mid-boot.
export const bootStartedAt = computed(() => progress.value?.startedAt);
