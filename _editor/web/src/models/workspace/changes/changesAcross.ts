import type { SandboxSummary } from "@intentic/api-contract";
import { type GitChanges, type RepoChanges, RepoChangesSchema } from "@intentic/sandbox-contract/schemas/git/git";
import { computed, ref } from "vue";
import { z } from "zod";
import { changesAcrossKey, storedJson, storeJson } from "../../../app/storage/browserStorage";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { rpcKeyAt } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { type AcrossRecord, awaitAnswer, createAcrossStore } from "../../sandbox/live/acrossSandboxes";
import { answerOf, isAsleep, type SandboxAnswer } from "../../../client/sandbox/wake/sandboxAnswer";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { ahead, outgoingWork, unpublished } from "../push/outgoingWork";
import { truncatedTotal } from "./truncation";
import { usePushRun } from "../push/usePushRun";

// Ledger of work sitting on another sandbox and nowhere else: per repo, how much is uncommitted, how far ahead of
// its remote, whether ever published. No merged tree across boxes, only these numbers.
// Poll rules (pull, never wake a sleeping machine, leave a sleeping one alone, keep the last answer when a box goes
// quiet) live in acrossSandboxes.ts.
//
// WHAT A SLEEPING SANDBOX HOLDS IS WHAT IT HELD (2026-10-29). Nothing changes in a stopped sandbox, so its last answer is
// still true, and it is kept in this browser (`changesAcrossKey`) so a reload does not turn it into a box that "isn't
// answering". Only the repos worth a row are kept, with their file lists folded into counts.

// Slower than the fleet's poll; uncommitted work isn't urgent, this is background awareness only.
const POLL_MS = 90_000;
const FRESH_MS = 30_000;
// How long a Wake press waits for the box to answer, and how often it asks meanwhile: a sandbox asleep on its computer
// starts in seconds to a minute, the patience the active sandbox's own wait gives one (diagnose.ts ASLEEP_WAKE_PATIENCE_MS).
const WAKE_WITHIN_MS = 3 * 60_000;
const WAKE_EVERY_MS = 5_000;

const KeptChangesSchema = z.object({ readAt: z.number(), repos: z.array(RepoChangesSchema) });

// A repo as the ledger needs it kept: its counts, never its file lists, origins or scratch. The lists' lengths are folded
// into `truncated`, which is what `rowsOf` already adds back. Pure.
export const keptRepo = (repo: RepoChanges): RepoChanges => ({
    repo: repo.repo,
    branch: repo.branch,
    conflicted: [],
    staged: [],
    unstaged: [],
    truncated: { staged: repo.staged.length + (repo.truncated?.staged ?? 0), unstaged: repo.unstaged.length + (repo.truncated?.unstaged ?? 0) },
    remote: repo.remote,
    error: repo.error,
});

// allow(module-state): each box's kept answer, read from storage once per page rather than on every recompute
const kept = new Map<string, z.infer<typeof KeptChangesSchema> | undefined>();
const keptOf = (sandboxId: string): z.infer<typeof KeptChangesSchema> | undefined => {
    if (!kept.has(sandboxId)) {
        kept.set(sandboxId, storedJson(changesAcrossKey(sandboxId), KeptChangesSchema));
    }
    return kept.get(sandboxId);
};
const keep = (sandboxId: string, repos: readonly RepoChanges[]): void => {
    const value = { readAt: Date.now(), repos: repos.filter((repo) => worthShowing(rowOf(sandboxId, ``, repo))).map(keptRepo) };
    kept.set(sandboxId, value);
    storeJson(changesAcrossKey(sandboxId), value);
};

export interface BoxChanges extends AcrossRecord {
    readonly repos: readonly RepoChanges[];
    readonly unreachable: boolean;
}

// One push in flight at a time; a per-row press, not a bulk action. Both name their row (ledgerKey), since the
// ledger's rows are other boxes' and a switch changes which of them it lists.
// allow(module-state): the cross-sandbox ledger's one push, keyed by the box it runs on
const pushing = ref<string | undefined>(undefined);
// allow(module-state): why a ledger push was refused, keyed by its row like the push itself
const pushError = ref<{ readonly key: string; readonly reason: string } | undefined>(undefined);

const store = createAcrossStore<BoxChanges>({
    pollMs: POLL_MS,
    freshMs: FRESH_MS,
    // A box not read yet on this page starts from what it last held here, if anything.
    blank: (sandbox) => ({ sandbox, repos: keptOf(sandbox.id)?.repos ?? [], readAt: keptOf(sandbox.id)?.readAt, unreachable: false }),
    unreachable: () => ({ unreachable: true }),
    read: async (sandbox) => {
        const body: GitChanges = await sandboxRpc.git.changes(undefined, { context: { at: sandbox.id, background: true } });
        // Filed under this box's own key, so it's cleaned up the same way and cleared when that box lands work.
        queryClient.setQueryData(rpcKeyAt(sandbox.id, `git.changes`), body);
        keep(sandbox.id, body.repos);
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

// The one address a row, its press and its refusal share: a repo in a box.
export const ledgerKey = (row: LedgerRow): string => `${row.sandboxId}:${row.repo}`;

const rowOf = (sandboxId: string, sandboxName: string, repo: RepoChanges): LedgerRow => ({
    sandboxId,
    sandboxName,
    repo: repo.repo,
    branch: repo.branch,
    uncommitted: repo.error === undefined ? repo.staged.length + repo.unstaged.length + truncatedTotal(repo) : 0,
    ahead: ahead(repo),
    publish: unpublished(repo),
    unreadable: repo.error !== undefined,
});

// Exported separately from `ledgerRows` so this derivation can be tested without pinning the live poll.
export const rowsOf = (box: BoxChanges): LedgerRow[] => box.repos.map((repo) => rowOf(box.sandbox.id, box.sandbox.name, repo));

// Only repos with something to report; a clean repo elsewhere is not information and would bury the ones that are.
export const worthShowing = (row: LedgerRow): boolean => row.unreadable || row.uncommitted > 0 || row.ahead > 0 || row.publish;

// Every other box, answered or not, so a silent one reads as unknown rather than being dropped.
export const changeBoxes = store.entries;

export const ledgerRows = computed<readonly LedgerRow[]>(() => changeBoxes.value.flatMap((box) => rowsOf(box).filter(worthShowing)));

// Why a box is quiet, beside the box: what the ledger says on a line of its own.
export interface QuietBox {
    readonly box: BoxChanges;
    readonly answer: Exclude<SandboxAnswer, `answering` | `unknown`>;
}

// The boxes the ledger cannot vouch for, each with why: one not answering, one starting, and one asleep whose holdings
// were never read here. A sleeper whose last answer is known needs no line: what it held is what it holds. Pure.
export const quietOf = (box: BoxChanges): QuietBox | undefined => {
    const answer = answerOf(box.sandbox, box.answered);
    if (answer === `answering` || answer === `unknown` || (isAsleep(answer) && box.readAt !== undefined)) {
        return undefined;
    }
    return { box, answer };
};

export const quietChangeBoxes = computed<readonly QuietBox[]>(() => changeBoxes.value.flatMap((box) => quietOf(box) ?? []));

// The boxes asleep now, whose rows are their last answer and cannot be pushed from here until they wake.
export const sleepingChangeBoxes = computed<ReadonlySet<string>>(
    () => new Set(changeBoxes.value.filter((box) => isAsleep(answerOf(box.sandbox, box.answered))).map((box) => box.sandbox.id)),
);

// A Wake press: ask the platform to start it (`wake`, useSandbox's, which on somebody's own computer leaves the request
// its keeper collects), then read it until it answers. True once it did.
export const wakeAndRead = async (sandbox: SandboxSummary, wake: (sandboxId: string, source: `retry`) => Promise<void>): Promise<boolean> => {
    await wake(sandbox.id, `retry`);
    return awaitAnswer(store, sandbox.id, { everyMs: WAKE_EVERY_MS, withinMs: WAKE_WITHIN_MS });
};

// How much work is stranded on other machines, using the same `outgoingWork` derivation as the local panel.
// Undefined when nothing is outstanding, or nothing has answered — a number this can't stand behind isn't shown.
export const outgoingAcross = computed(() => outgoingWork(changeBoxes.value.flatMap((box) => box.repos)));

// Uncommitted work isn't part of `outgoingWork` (which counts commits only), so it's summed separately here.
export const uncommittedAcross = computed(() => ledgerRows.value.reduce((total, row) => total + row.uncommitted, 0));

// Pushes one row's commits directly, outside the push flow: a refusal's terminal is on a box you aren't standing in, so
// the row carries the reason instead. Switching to that sandbox to push there is one press away.
export const pushRow = async (row: LedgerRow): Promise<void> => {
    const key = ledgerKey(row);
    if (pushing.value !== undefined) {
        return;
    }
    pushing.value = key;
    pushError.value = undefined;
    try {
        // Started, then followed to its verdict, so a slow hook on that box doesn't hang this request.
        const result = await usePushRun(row.repo, row.sandboxId).start();
        if (result.status !== `passed`) {
            pushError.value = { key, reason: result.reason ?? t(`workspace.changesAcross.pushRefused`) };
        }
        // Re-reads only this box; a push here doesn't change any other box's counts.
        await store.readOne(row.sandboxId);
    } catch (caught) {
        pushError.value = { key, reason: messageOr(caught, t(`workspace.changesAcross.pushFailed`)) };
    } finally {
        pushing.value = undefined;
    }
};

export const pushingRow = computed(() => pushing.value);
// Said only while its row is listed: switching into the box it was about takes that row off this ledger.
export const pushRowError = computed(() => {
    const refused = pushError.value;
    return refused !== undefined && ledgerRows.value.some((row) => ledgerKey(row) === refused.key) ? refused.reason : undefined;
});
export const dismissPushError = (): void => {
    pushError.value = undefined;
};

// False on a one-sandbox account, where the ledger would only ever show an empty heading.
export const hasOtherSandboxes = computed(() => changeBoxes.value.length > 0);
