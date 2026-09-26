import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import type { PortForwards } from "../ports/port-forwards.js";
import type { ListeningPort } from "../ports/port-scan.js";
import { createTerminalRunner, type TerminalRunner } from "../terminal/terminal-run.js";
import { createManagedProcesses, type ManagedProcesses } from "./managed-processes.js";
import { createServiceProcesses, type ServiceProcesses } from "./service-processes.js";

// Processes the daemon runs: managed dev servers, service processes, the terminal runner, and the ports they listen on.
export interface ProcessesSlice {
    // Per-repo operator panels: the in-memory process manager the /panels routes and preview proxy drive.
    readonly processes: ManagedProcesses;
    // Extensions' declared background processes as the daemon's own children (respawn, one log file each).
    readonly serviceProcesses: ServiceProcesses;
    // Runs user-triggered shell commands inside visible job-* tmux sessions, one window per command.
    readonly terminalRun: TerminalRunner;
    // Forwarded-port slot table the /ports routes drive and the preview proxy resolves port-<slot> hosts against.
    readonly portForwards: PortForwards;
    // Discovers every listening TCP socket via procfs, traced back to the terminal it runs in.
    readonly scanPorts: () => Promise<ListeningPort[]>;
}

// The members ports/ builds, which composition.ts adds: building them here would close ports -> system -> processes.
export type PortsMembers = "portForwards" | "scanPorts";

// Builds the processes slice but for its ports; what else reads a member of it (the ACP pool, the dependency
// coordinator, the panel resolver) takes it from here, so there is one instance of each.
export const createProcessesSlice = ({ config, logger }: { readonly config: Pick<Config, "historyRoot">; readonly logger: Logger }): Omit<
    ProcessesSlice,
    PortsMembers
> => ({
    processes: createManagedProcesses(undefined, { logger }),
    serviceProcesses: createServiceProcesses(join(config.historyRoot, "logs", "services"), logger),
    terminalRun: createTerminalRunner(),
});
