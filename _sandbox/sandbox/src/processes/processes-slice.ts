import type { PortForwards } from "../ports/port-forwards.js";
import type { ListeningPort } from "../ports/port-scan.js";
import type { TerminalRunner } from "../terminal/terminal-run.js";
import type { ManagedProcesses } from "./managed-processes.js";
import type { ServiceProcesses } from "./service-processes.js";

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
