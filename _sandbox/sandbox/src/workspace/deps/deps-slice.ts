import { join } from "node:path";
import type { Logger } from "pino";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { fileHeavyCommandsStore, heavyCommandsDocument, heavyEnvPrefix, type HeavyCommandsStore } from "../../system/resources/heavy-commands.js";
import { QUEUE_RUN_BIN, queueRunEnabled } from "../../terminal/terminal-run.js";
import type { WorkspacePaths } from "../workspace.js";
import { createDependencyCoordinator, type DependencyCoordinator, dependencyRequestsDocument } from "./reconcile-deps.js";

// The main tree's dependencies and the heavy-command queue.
export interface DepsSlice {
    // Single owner of dependency status, durable setup requests, watcher reconciliation and installs.
    readonly dependencies: DependencyCoordinator;
    // Which programs are heavy enough to queue: the shipped table with the owner's overrides; the Bash hook reads it per
    // command, binding on the next one.
    readonly heavyCommands: HeavyCommandsStore;
    // One whole line under the heavy table (agent-terminals.ts queueWhole), its heavy programs queueing as they start: for
    // what the daemon runs itself, here and for a parent on a runner, rather than what an agent types.
    readonly queueHeavy: (line: string) => Promise<string>;
}

export interface DepsSliceDeps {
    readonly workspace: WorkspacePaths;
    readonly historyRoot: string;
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
}

// The member composition.ts adds: the heavy queue is the agent's terminal lane (agent/tools/agent-terminals.ts), and
// importing it here would close a cycle back into workspace/.
export type QueueMembers = "queueHeavy";

// Builds the slice but for the heavy queue.
export const createDepsSlice = ({ workspace, historyRoot, processes, logger }: DepsSliceDeps): Omit<DepsSlice, QueueMembers> => {
    const heavyCommands = fileHeavyCommandsStore(join(workspace.root, heavyCommandsDocument.path), (reason) =>
        logger.warn(`heavy-commands: ${reason}, falling back to the shipped rules`),
    );
    return {
        dependencies: createDependencyCoordinator({
            workspace,
            processes,
            logger,
            requestsPath: join(historyRoot, dependencyRequestsDocument.path),
            // The daemon's install joins the lane an agent's own install takes (heavy-rules.cjs `dependency-install`),
            // judged as it starts like any agent program; a table that cannot be read runs it unqueued.
            lane: async (command) => {
                try {
                    return `${heavyEnvPrefix(await heavyCommands.read(), { queueRun: queueRunEnabled() ? QUEUE_RUN_BIN : undefined })}bash -c ${shellQuote(command)}`;
                } catch {
                    return command;
                }
            },
        }),
        heavyCommands,
    };
};
