// The nightly update drill's hook: INTENTIC_FAULT makes a build fail on purpose, the three ways an update can go wrong,
// so the host's rollback is exercised against a real failure rather than trusted. Production images never set it, and
// any other value is ignored.
// - crash-at-boot: the boot fails before the stored files are converged, and records why like any failed boot.
// - crash-after-ready: the process exits 20 seconds after the gate opens, a version that keeps crashing once up.
// - fail-conversion: converging throws once an episode is open (store/evolution/state-convergence.ts), so the files
//   are put back and /health reports the journal failed.

export type BootFault = "crash-at-boot" | "crash-after-ready" | "fail-conversion";

const FAULTS: readonly BootFault[] = ["crash-at-boot", "crash-after-ready", "fail-conversion"];

// How long a crash-after-ready build stays up: past the host's first health check, inside its probation.
export const CRASH_AFTER_READY_MS = 20_000;

// Read once, at the start of main(); undefined for an unset or unknown value.
export const bootFault = (env: NodeJS.ProcessEnv = process.env): BootFault | undefined => FAULTS.find((fault) => fault === env["INTENTIC_FAULT"]);
