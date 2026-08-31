import type { GitActionResult, GitChangesResponse, RepoChanges,SandboxSummary } from "@intentic-app/api-contract";
import { computed, ref, shallowRef, watch } from "vue";
import { errorMessage } from "@intentic/ui/async";
import { onScreen } from "../onScreen";
import { GIT_CHANGES } from "../queryKeys";
import { queryClient } from "../queryPersistence";
import { jsonBody } from "../sandbox/jsonBody";
import { connectedSandboxes } from "../sandbox/roster";
import { sandboxJsonAt } from "../sandbox/sandboxClient";
import { useSandbox } from "../sandbox/useSandbox";
import { ahead, outgoingWork, unpublished } from "./outgoingWork";

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
 * It shares fleetAcross's rules for the same reasons, stated once there: pull rather than stream, never wake a
 * sleeping machine, run only while a surface is subscribed, and keep the last answer when a box goes quiet
 * rather than reporting a zero nobody established. */

// Slower than the fleet's poll. Nothing here is a live feed: uncommitted work does not become urgent in the
// seconds after it appears, and this is background awareness while the reader is looking at their own repos.
const POLL_MS = 90_000;
const FRESH_MS = 30_000;

export interface BoxChanges {
    readonly sandbox: SandboxSummary;
    readonly repos: readonly RepoChanges[];
    // Never answered yet. The one state a surface must not render as "nothing outstanding".
    readonly readAt: number | undefined;
    readonly unreachable: boolean;
}

const boxes = shallowRef<Record<string, BoxChanges>>({});
// The push this module has in flight, and how it went. One at a time, since it is a per-row press and two
// pushes from one sidebar is not a thing anybody asks for.
const pushing = ref<string | undefined>(undefined);
const pushError = ref<string | undefined>(undefined);

const { sandboxes, activeSandboxId } = useSandbox();

const targets = computed<readonly SandboxSummary[]>(() =>
    connectedSandboxes(sandboxes.value).filter((sandbox) => sandbox.id !== activeSandboxId.value),
);

const write = (id: string, patch: Partial<BoxChanges> & { readonly sandbox: SandboxSummary }): void => {
    const previous = boxes.value[id];
    boxes.value = {
        ...boxes.value,
        [id]: { repos: previous?.repos ?? [], readAt: previous?.readAt, unreachable: previous?.unreachable ?? false, ...patch },
    };
};

const inFlight = new Set<string>();

const dueFor = (sandbox: SandboxSummary, force: boolean): boolean => {
    if (inFlight.has(sandbox.id)) {
        return false;
    }
    const readAt = boxes.value[sandbox.id]?.readAt;
    return force || readAt === undefined || Date.now() - readAt >= FRESH_MS;
};

const readBox = async (sandbox: SandboxSummary, force: boolean): Promise<void> => {
    if (!dueFor(sandbox, force)) {
        return;
    }
    inFlight.add(sandbox.id);
    try {
        const body = await sandboxJsonAt<GitChangesResponse>(sandbox.id, `/git/changes`);
        write(sandbox.id, { sandbox, repos: body.repos, readAt: Date.now(), unreachable: false });
        // Filed under that box's own key, so the entry is swept by the same machinery that sweeps everything
        // else this browser remembers about it (sandboxQueryPredicate reads the id in the last position), and
        // so a land performed on that box from the fleet board drops this with `GIT_CHANGES.every`.
        queryClient.setQueryData(GIT_CHANGES.ofSandbox(sandbox.id), body);
    } catch {
        // One answer for every cause, as in fleetAcross: asleep, tunnel down, lid closed and mid-rebuild are
        // indistinguishable from here and mean the same thing to a reader.
        write(sandbox.id, { sandbox, unreachable: true });
    } finally {
        inFlight.delete(sandbox.id);
    }
};

const readAll = (force: boolean): void => {
    for (const sandbox of targets.value) {
        void readBox(sandbox, force);
    }
};

let watchers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let watching: (() => void)[] = [];

const syncLoop = (): void => {
    if (watchers > 0 && onScreen.value) {
        timer ??= setInterval(() => readAll(false), POLL_MS);
        return;
    }
    if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
    }
};

// Registered with the first subscriber rather than at module scope, for the reason fleetAcross gives: a watch
// evaluates its source to take a first reading, so a module-scope one would pull the sandbox list into
// existence on import, in every window, whether or not anything ever asks this question.
const startWatching = (): void => {
    watching = [
        watch(onScreen, (visible) => {
            syncLoop();
            if (visible && watchers > 0) {
                readAll(true);
            }
        }),
        watch(targets, () => {
            if (watchers > 0) {
                readAll(false);
            }
        }),
    ];
};

export const subscribeChanges = (): (() => void) => {
    watchers += 1;
    if (watchers === 1) {
        startWatching();
    }
    syncLoop();
    readAll(false);
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        watchers -= 1;
        if (watchers === 0) {
            for (const stop of watching) {
                stop();
            }
            watching = [];
        }
        syncLoop();
    };
};

// A caller's own "check now": the ledger's Retry, and the seam after work landed into another box's /work.
// A no-op when nothing is subscribed, for the reason fleetAcross's own gives: this store exists only while a
// surface is reading it, and a refresh must not be the one door around that.
export const refreshChangesAcross = (): void => {
    if (watchers > 0) {
        readAll(true);
    }
};

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
        uncommitted: repo.error === undefined ? repo.staged.length + repo.unstaged.length + (repo.truncated ?? 0) : 0,
        ahead: ahead(repo),
        publish: unpublished(repo),
        unreadable: repo.error !== undefined,
    }));

// Only the repos with something to say. A clean repo in another sandbox is not information, and listing every
// repo of every box would bury the two rows that are the reason to look.
export const worthShowing = (row: LedgerRow): boolean => row.unreadable || row.uncommitted > 0 || row.ahead > 0 || row.publish;

// Every other box, whether or not it has answered, so a silent one is drawn as unknown rather than dropped.
export const changeBoxes = computed<readonly BoxChanges[]>(() =>
    targets.value.map((sandbox) => boxes.value[sandbox.id] ?? { sandbox, repos: [], readAt: undefined, unreachable: false }),
);

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
        const result = await sandboxJsonAt<GitActionResult>(row.sandboxId, `/git/${encodeURIComponent(row.repo)}/push`, jsonBody(`POST`, {}));
        if (!result.ok) {
            pushError.value = result.reason ?? `That push was refused.`;
        }
        // Whether it went or was refused, this box's counts have moved or been proven wrong. Re-read that box
        // alone: the others did not change because this one pushed.
        const box = targets.value.find((candidate) => candidate.id === row.sandboxId);
        if (box !== undefined) {
            await readBox(box, true);
        }
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
export const hasOtherSandboxes = computed(() => targets.value.length > 0);
