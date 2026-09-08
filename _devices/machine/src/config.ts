import { join } from "node:path";
import { agentHome } from "@intentic/local-agent";

// ~/.intentic/machine holds both halves' state; separate files avoid needing a cross-process lock.
const home = agentHome("machine");
export const baseDir = home.dir;

// Resident loop's pidfile (pid+boot, see detached.ts) and log; shared since both halves run one loop.
export const runPidPath = join(baseDir, "machine.pid");
export const runLogPath = join(baseDir, "machine.log");

// Where a sandbox-triggered update/restart writes; kept separate so its own run is easy to find later.
export const agentLogPath = join(baseDir, "machine-update.log");
