import { isUnversionedStatePath } from "@intentic/sandbox-contract/state/workspace-state";

// Which workspace change batches a reaction has to act on. The watcher reports every write it sees, the daemon's own
// included, and under load the daemon rewrites its state every few seconds (the privacy ledger, extension usage,
// browser screenshots). Measured with seven sessions running (2026-10-08): a batch every 2.5 s, none of them code, and
// each one re-walked the whole tree for the code-search index of the time (about 10k stats a sweep) and re-read git for
// every land standing.

// An empty batch names nothing (a truncated burst, a write under a pruned dir) and so might hold anything; a named one
// counts only when some path passes `matters`.
export const batchMatters = (paths: readonly string[], matters: (path: string) => boolean): boolean => paths.length === 0 || paths.some(matters);

// What git could see: status, landings and standings are read off refs and tracked files, never off machine state.
export const gitMatters = (path: string): boolean => !isUnversionedStatePath(path);
