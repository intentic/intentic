import { join } from "node:path";
import { agentHome } from "@intentic/local-agent";

// ~/.intentic/machine holds both halves' state; separate files avoid needing a cross-process lock.
const home = agentHome("machine");
export const baseDir = home.dir;

// The agent binary, the launcher stub and Mutagen; everything here is swapped by rename, never overwritten.
export const binDir = join(baseDir, "bin");

// Resident agent's pidfile (its JSON record, see local-agent's detached.ts) and log; both halves run in that one agent.
export const runPidPath = join(baseDir, "machine.pid");
export const runLogPath = join(baseDir, "machine.log");

// Where a sandbox-triggered or automatic update/restart writes; kept separate so its own run is easy to find later.
export const agentLogPath = join(baseDir, "machine-update.log");

// The computer-wide state only the root environment holds: its supervised distros and the update switches.
export const machineConfigPath = join(baseDir, "machine.json");

// Held while one upgrade runs in this environment; a second waits for it rather than splicing into its download.
export const upgradeLockPath = join(binDir, "upgrade.lock");
