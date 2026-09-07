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

/* WORK THAT EXISTS ON ONE MACHINE AND NOWHERE ELSE, counted across every sandbox but this one.
 *
 * `outgoingWork.ts` already names the risk for the box you are standing in: a repo whose commits are on this
 * disk alone, on a machine that can go away. What it cannot see is the other three sandboxes, where the same
 * thing is true and nothing at all is counting it. On an account where agents commit for you, across several
 * boxes, that is the most consequential invisible state in the product.
 *
 * A LEDGER, NOT A TREE, and that is the whole shape of this module. There is no merged workspace to browse:
 * two boxes' `/work/intentic` are two checkouts, their paths collide, and neither is the other's parent. What
 * IS answerable across boxes is per repo and numeric, how much is uncommitted, how far ahead of its remote it
 * is, whether its branch has ever been published, so that is what this reads and all it reads.
 *
 * The reading loop is acrossSandboxes.ts, which states its rules once for both stores over it: pull rather
 * than stream, never wake a sleeping machine, run only while a surface is subscribed, and keep the last answer
 * when a box goes quiet rather than reporting a zero nobody established. */

// Slower than the fleet's poll. Nothing here is a live feed: uncommitted work does not become urgent in the
// seconds after it appears, and this is background awareness while the reader is looking at their own repos.
const POLL_MS = 90_000;
const FRESH_MS = 30_000;

export interface BoxChanges extends AcrossRecord {
    readonly repos: readonly RepoChanges[];
    readonly unreachable: boolean;
}

// The push this module has in flight, and how it went. One at a time, since it is a per-row press and two
// pushes from one sidebar is not a thing anybody asks for.
const pushing = ref<string | undefined>(undefined);
const pushError = ref<string | undefined>(undefined);

const store = createAcrossStore<BoxChanges>({
    pollMs: POLL_MS,
    freshMs: FRESH_MS,
    blank: (sandbox) => ({ sandbox, repos: [], readAt: undefined, unreachable: false }),
    unreachable: () => ({ unreachable: true }),
    read: async (sandbox) => {
        const body = await sandboxJsonQuietly<GitChangesResponse>(sandbox.id, `/git/changes`);
        // Filed under that box's own key, so the entry is swept by the same machinery that sweeps everything
        // else this browser remembers about it (sandboxQueryPredicate reads the id in the last position), and
        // so a land performed on that box from the fleet board drops this with `GIT_CHANGES.every`.
        queryClient.setQueryData(GIT_CHANGES.ofSandbox(sandbox.id), body);
        return { repos: body.repos, unreachable: false };
    },
});

export const subscribeChanges = store.subscribe;

// A caller's own "check now": the ledger's Retry, and the seam after work landed into another box's /work.
export const refreshChangesAcross = store.refresh;

/* ONE ROW OF THE LEDGER: a repo in a sandbox, and the three numbers that say what it is holding.
 *
 * `uncommitted` counts the two sides git models, plus what the daemon truncated past its budget, because a
 * six-figure change list is exactly the case where the count matters and exactly the one where the rows were
 * cut. `conflicted` is not counted: it is not work being held, it is a repo halted mid-merge, and folding the
 * two together would report a stuck rebase as unsaved work. */
export interface LedgerRow {
    readonly sandboxId: string;
    readonly sandboxName: string;
    readonly repo: string;
    readonly branch: string | undefined;
    readonly uncommitted: number;
    readonly ahead: number;
    readonly publish: boolean;
    // The repo could not be scanned at all. Its numbers are unknown rather than zero, exactly like an
    // unreachable box's, and the row says so instead of claiming it is clean.
    readonly unreadable: boolean;
}

// Exported for its own test rather than only through `ledgerRows`: this is the whole reading the surface
// makes of a box, and pinning it through the live store would mean pinning the poll to get at the derivation.
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

// Only the repos with something to say. A clean repo in another sandbox is not information, and listing every
// repo of every box would bury the two rows that are the reason to look.
export const worthShowing = (row: LedgerRow): boolean => row.unreadable || row.uncommitted > 0 || row.ahead > 0 || row.publish;

// Every other box, whether or not it has answered, so a silent one is drawn as unknown rather than dropped.
export const changeBoxes = store.entries;

export const ledgerRows = computed<readonly LedgerRow[]>(() => changeBoxes.value.flatMap((box) => rowsOf(box).filter(worthShowing)));

export const silentChangeBoxes = computed<readonly BoxChanges[]>(() => changeBoxes.value.filter((box) => box.unreachable));

/* THE HEADLINE, and the reason this surface exists: how much work is sitting on machines other than this one
 * with nowhere else to be. The same `outgoingWork` derivation the local panel uses, so the sentence a reader
 * has already learned in one place means exactly the same thing here.
 *
 * Undefined when nothing is outstanding OR when nothing has answered, and those two really are one answer for
 * a headline: a number this cannot stand behind must not be printed as one. The rows below say which boxes
 * were silent. */
export const outgoingAcross = computed(() => outgoingWork(changeBoxes.value.flatMap((box) => box.repos)));

// Uncommitted work is not `outgoingWork`'s business (it counts commits), so it is counted here: the two are
// different exposures and a reader deciding whether to go and look wants both.
export const uncommittedAcross = computed(() => ledgerRows.value.reduce((total, row) => total + row.uncommitted, 0));

/* SEND ONE ROW'S COMMITS, from here, without switching.
 *
 * DELIBERATELY NOT BEHIND THE PRE-PUSH CHECK. `usePushFlow` runs the sandbox's own pre-push command before it
 * sends anything, and exports no single-repo push precisely so that a second route to the verb cannot be a
 * route around the check. That reasoning is about the box you are working in, where the check is configured,
 * where its output has a terminal to appear in, and where a red verdict can be handed to an agent. None of
 * those exist for a repo on another machine, and a check whose failure the reader cannot see or act on is
 * worse than none.
 *
 * So this is the narrow verb it looks like: git push, for a repo whose commits are already made, reported by
 * its own result. What it is for is the case the whole module is for, work stranded on a box nobody is going
 * back to. Crossing to that sandbox and pushing there, with its checks, is one press away on every row.
 */
export const pushRow = async (row: LedgerRow): Promise<void> => {
    const key = `${row.sandboxId}:${row.repo}`;
    if (pushing.value !== undefined) {
        return;
    }
    pushing.value = key;
    pushError.value = undefined;
    try {
        // The push is a run there as it is here (usePushRun.ts): started, then followed to its verdict, so a
        // hook that takes minutes on that box does not take this request down with it.
        const result = await usePushRun(row.repo, row.sandboxId).start();
        if (result.status !== `passed`) {
            pushError.value = result.reason ?? `That push was refused.`;
        }
        // Whether it went or was refused, this box's counts have moved or been proven wrong. Re-read that box
        // alone: the others did not change because this one pushed.
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

// Is there anywhere else to look? The ledger draws nothing at all on a one-sandbox account, where it could
// only ever be an empty heading explaining a feature the reader has no use for yet.
export const hasOtherSandboxes = computed(() => changeBoxes.value.length > 0);
