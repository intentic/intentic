import type { GitView } from "@intentic/sandbox-contract/schemas/git/git-view";

// Demo Git handlers settle synchronously. Each request selects its own simulated checkout.
let current: GitView | undefined;
export const gitView = (): GitView | undefined => current;
export const viewKey = (): string => current?.agent !== undefined ? `agent:${current.agent}` : current?.branch !== undefined ? `branch:${current.repo ?? `root`}/${current.branch}` : ``;
export const inGitView = <T>(view: GitView | undefined, run: () => T): T => {
    const previous = current;
    current = view;
    try { return run(); } finally { current = previous; }
};
