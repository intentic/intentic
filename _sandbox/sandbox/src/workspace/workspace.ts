export interface WorkspacePaths {
    readonly root: string;
}

// The on-disk layout: repos live directly under <root> (VSCode-style, a repo is any directory owning a .git, wherever
// it sits; see repo-discovery.ts). Pure path derivation so the daemon, the CLI, and tests all agree on the root.
export const workspacePaths = (root: string): WorkspacePaths => ({ root });
