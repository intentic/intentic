import type { GitChangesResponse, RepoChanges } from "@intentic/api-contract";
import { computed, ref } from "vue";
import { errorMessage } from "@intentic/ui/async";
import { GIT_CHANGES } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { type AcrossRecord, createAcrossStore } from "../../sandbox/live/acrossSandboxes";
import { sandboxJsonQuietly } from "../../sandbox/client/sandboxClient";
import { ahead, outgoingWork, unpublished } from "../push/outgoingWork";
import { truncatedTotal } from "./truncation";
import { usePushRun } from "../push/usePushRun";

// Ledger of work sitting on another sandbox and nowhere else: per repo, how much is uncommitted, how far ahead of
// its remote, whether ever published. No merged tree across boxes, only these numbers.
// Poll rules (pull, never wake a sleeping machine, keep the last answer when a box goes quiet) live in
// acrossSandboxes.ts.

// Slower than the fleet's poll; uncommitted work isn't urgent, this is background awareness only.
const POLL_MS = 90_000;
const FRESH_MS = 30_000;

export interface BoxChanges extends AcrossRecord {
    readonly repos: readonly RepoChanges[];
    readonly unreachable: boolean;
}

// One push in flight at a time; a per-row press, not a bulk action.
const pushing = ref<string | undefined>(undefined);
const pushError = ref<string | undefined>(undefined);

const store = createAcrossStore<BoxChanges>({
    pollMs: POLL_MS,
    freshMs: FRESH_MS,
    blank: (sandbox) => ({ sandbox, repos: [], readAt: undefined, unreachable: false }),
    unreachable: () => ({ unreachable: true }),
    read: async (sandbox) => {
        const body = await sandboxJsonQuietly<GitChangesResponse>(sandbox.id, `/git/changes`);
        // Filed under this box's own key, so it's cleaned up the same way and cleared when that box lands work.
        queryClient.setQueryData(GIT_CHANGES.ofSandbox(sandbox.id), body);
        return { repos: body.repos, unreachable: false };
    },
});

export const subscribeChanges = store.subscribe;

// Manual refresh: the ledger's Retry button, and the hook after work lands into another box's /work.
export const refreshChangesAcross = store.refresh;

// One row of the ledger: a repo in a sandbox and what it's holding.
// `uncommitted` includes truncated counts past the daemon's budget; a halted merge's conflicts are excluded.
export interface LedgerRow {
    readonly sandboxId: string;
    readonly sandboxName: string;
    readonly repo: string;
    readonly branch: string | undefined;
    readonly uncommitted: number;
    readonly ahead: number;
    readonly publish: boolean;
    // True when the repo couldn't be scanned at all; numbers read as unknown, not clean.
    readonly unreadable: boolean;
}

// Exported separately from `ledgerRows` so this derivation can be tested without pinning the live poll.
export const rowsOf = (box: BoxChanges): LedgerRow[] =>
    box.repos.map((repo) => ({
        sandboxId: box.sandbox.id,
        sandboxName: box.sandbox.name,
        repo: repo.repo,
        branch: repo.branch,
        uncommitted: repo.error === undefined ? repo.staged.length + repo.unstaged.length + truncatedTotal(repo) : 0,
        ahead: ahead(repo),
        publish: unpublished(repo),
        unreadable: repo.error !== undefined,
    }));

// Only repos with something to report; a clean repo elsewhere is not information and would bury the ones that are.
export const worthShowing = (row: LedgerRow): boolean => row.unreadable || row.uncommitted > 0 || row.ahead > 0 || row.publish;

// Every other box, answered or not, so a silent one reads as unknown rather than being dropped.
export const changeBoxes = store.entries;

export const ledgerRows = computed<readonly LedgerRow[]>(() => changeBoxes.value.flatMap((box) => rowsOf(box).filter(worthShowing)));

export const silentChangeBoxes = computed<readonly BoxChanges[]>(() => changeBoxes.value.filter((box) => box.unreachable));

// How much work is stranded on other machines, using the same `outgoingWork` derivation as the local panel.
// Undefined when nothing is outstanding, or nothing has answered — a number this can't stand behind isn't shown.
export const outgoingAcross = computed(() => outgoingWork(changeBoxes.value.flatMap((box) => box.repos)));

// Uncommitted work isn't part of `outgoingWork` (which counts commits only), so it's summed separately here.
export const uncommittedAcross = computed(() => ledgerRows.value.reduce((total, row) => total + row.uncommitted, 0));

// Pushes one row's commits directly, without the sandbox's pre-push check — that check's output has nowhere to
// appear for a box you aren't standing in. Switching to that sandbox to push there is one press away.
export const pushRow = async (row: LedgerRow): Promise<void> => {
    const key = `${row.sandboxId}:${row.repo}`;
    if (pushing.value !== undefined) {
        return;
    }
    pushing.value = key;
    pushError.value = undefined;
    try {
        // Started, then followed to its verdict, so a slow hook on that box doesn't hang this request.
        const result = await usePushRun(row.repo, row.sandboxId).start();
        if (result.status !== `passed`) {
            pushError.value = result.reason ?? `That push was refused.`;
        }
        // Re-reads only this box; a push here doesn't change any other box's counts.
        await store.readOne(row.sandboxId);
    } catch (caught) {
        pushError.value = errorMessage(caught, `That push didn't work.`);
    } finally {
        pushing.value = undefined;
    }
};

export const pushingRow = computed(() => pushing.value);
export const pushRowError = computed(() => pushError.value);
export const dismissPushError = (): void => {
    pushError.value = undefined;
};

// False on a one-sandbox account, where the ledger would only ever show an empty heading.
export const hasOtherSandboxes = computed(() => changeBoxes.value.length > 0);
