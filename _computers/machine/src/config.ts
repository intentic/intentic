import { join } from "node:path";
import { agentHome } from "@intentic/local-agent";

/* ONE STATE HOME FOR THE WHOLE AGENT, `~/.intentic/machine`, holding both halves' state side by side.
 *
 * The two halves keep SEPARATE files under it (`computer.json` for the sandbox links, `sync.json` for the
 * pairings) rather than sharing one, and that is a concurrency decision, not tidiness: the resident loop
 * rewrites the links on every scope push and the pairings on every port reconcile, while a `setup` running in
 * another process writes its own half at the same moment. Two files mean the two writers can never tear each
 * other's state; one file would need a cross-process lock to say the same thing. */
const home = agentHome("machine");
export const baseDir = home.dir;

/* THE RESIDENT LOOP'S OWN THREE FILES, shared by both halves because there is one loop.
 *
 * The pidfile is how a later `status`, `run --stop`, `upgrade` or `uninstall` reaches a loop no shell owns any
 * more (pid + the boot it belongs to, see @intentic/local-agent's detached.ts). The log is where every
 * supervising mechanism (launchd, systemd, the Windows launcher stub) sends the loop's output, and the file
 * every failure note names. */
export const runPidPath = join(baseDir, "machine.pid");
export const runLogPath = join(baseDir, "machine.log");
