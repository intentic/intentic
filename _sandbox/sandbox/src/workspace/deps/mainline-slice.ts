import { join } from "node:path";
import type { Logger } from "pino";
import type { ManagedProcesses } from "../../processes/managed-processes.js";
import { fileHeavyCommandsStore, heavyCommandsDocument, type HeavyCommandsStore } from "../../system/resources/heavy-commands.js";
import type { WorkspacePaths } from "../workspace.js";
import { filePushChecksStore, pushChecksDocument } from "./push-checks-store.js";
import { createPushChecks, type PushChecks } from "./push-checks.js";
import { createDependencyCoordinator, type DependencyCoordinator, dependencyRequestsDocument } from "./reconcile-deps.js";
import type { LandCheck } from "./verify-deps.js";
import { fileVerifyStore, verifyDocument, type VerifyStore } from "./verify-store.js";

// The main tree's own check and its dependencies: the land check, its verdicts, push findings and the heavy-command queue.
export interface MainlineSlice {
    // Single owner of dependency status, durable setup requests, watcher reconciliation and installs.
    readonly dependencies: DependencyCoordinator;
    // Dependency verifier's memory: last verdict per project plus red streak, what makes deps.fixed an edge.
    readonly verifyStore: VerifyStore;
    // The check after landing, one queue for every door into it (workspace/deps/verify-deps.ts).
    readonly landCheck: LandCheck;
    // What each push check let through and what became of it: filed from the hook's report once the push reached its
    // remote, measured again on a press or after a land check, dismissed by the owner. Never sent to anyone by itself.
    readonly pushChecks: PushChecks;
    // Which programs are heavy enough to queue: the shipped table with the owner's overrides; the Bash hook reads it per
    // command, binding on the next one.
    readonly heavyCommands: HeavyCommandsStore;
    // One whole line under the heavy table (agent-terminals.ts queueWhole), its heavy programs queueing as they start: for
    // what the daemon runs itself, here and for a parent on a runner, rather than what an agent types.
    readonly queueHeavy: (line: string) => Promise<string>;
    // The check after landing's own queue prefix, the `repo-verify` rule by name; what offload-run keeps for running it here.
    readonly heavyPrefix: (line: string) => Promise<string>;
}

export interface MainlineDeps {
    readonly workspace: WorkspacePaths;
    readonly historyRoot: string;
    readonly processes: ManagedProcesses;
    readonly logger: Logger;
}

// The members composition.ts adds: the land check hands a red run to conversations/, and the heavy queue is the agent's
// terminal lane (agent/tools/agent-terminals.ts); importing either here would close a cycle back into workspace/.
export type LandMembers = "landCheck" | "queueHeavy" | "heavyPrefix";

// Builds the mainline slice but for the land check and the heavy queue.
export const createMainlineSlice = ({ workspace, historyRoot, processes, logger }: MainlineDeps): Omit<MainlineSlice, LandMembers> => ({
    dependencies: createDependencyCoordinator({
        workspace,
        processes,
        logger,
        requestsPath: join(historyRoot, dependencyRequestsDocument.path),
    }),
    verifyStore: fileVerifyStore(join(workspace.root, verifyDocument.path)),
    pushChecks: createPushChecks({
        root: workspace.root,
        store: filePushChecksStore(join(workspace.root, pushChecksDocument.path)),
        logger,
    }),
    heavyCommands: fileHeavyCommandsStore(join(workspace.root, heavyCommandsDocument.path), (reason) =>
        logger.warn(`heavy-commands: ${reason}, falling back to the shipped rules`),
    ),
});
