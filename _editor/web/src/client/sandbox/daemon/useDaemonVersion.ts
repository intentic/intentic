import { sandboxRef } from "@intentic/extension-api";
import { daemonBelowFloor, daemonVersionOfBuild, type Hello, OLDEST_SUPPORTED_DAEMON } from "@intentic/sandbox-contract";
import { computed } from "vue";

// Which release the active sandbox's daemon runs, read off the head of its /events hello's `build`, and whether that is
// older than the oldest daemon this app supports (OLDEST_SUPPORTED_DAEMON in the contract). Below the floor the app
// draws one page saying so (SandboxGate, SandboxTooOld) rather than the feature-by-feature faults an older daemon
// would otherwise come back as. Sandbox-scoped like the route list beside it, so one sandbox's age is never another's.

// Undefined until a hello names a version: before connecting, a hello with no build, or the desktop app's folder
// sidecar, whose age says nothing about a sandbox.
const reported = sandboxRef<string | undefined>(() => undefined);

// Called on every hello frame. A folder on this computer ships with this page and is never too old.
export const setDaemonVersion = (build: string | undefined, surface?: Hello[`surface`]): void => {
    reported.value = surface === `folder` ? undefined : daemonVersionOfBuild(build);
};

// The release the active daemon runs; `0.0.0` for one built from a checkout.
export const daemonVersion = computed(() => reported.value);

// Only on evidence: a released daemon older than the floor. A checkout's build (0.0.0) and a daemon of unknown age are
// never too old.
export const daemonTooOld = computed(() => daemonBelowFloor(reported.value));

// What the page names as the oldest release it works with.
export const oldestSupportedDaemon = OLDEST_SUPPORTED_DAEMON;
