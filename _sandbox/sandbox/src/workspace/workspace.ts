import { join } from "node:path";
import type { RepoRole } from "@intentic/scaffold";

export interface WorkspacePaths {
    readonly root: string;
    readonly repos: Readonly<Record<RepoRole, string>>;
}

// The on-disk layout: the three fixed-role repos live directly under <root> (VSCode-style, a repo is any
// directory owning a .git, wherever it sits; see repo-discovery.ts). Pure path derivation so the daemon, the
// CLI, and tests all agree on where each role lives.
export const workspacePaths = (root: string): WorkspacePaths => ({
    root,
    repos: {
        intent: join(root, "intent"),
        "desired-state": join(root, "desired-state"),
        app: join(root, "app"),
    },
});
