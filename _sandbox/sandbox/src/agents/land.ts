import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpan, GitChange, LandConflict, LandConflictReason, LandMode, LandResult } from "@intentic/sandbox-contract";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";
import { changedFiles, headSha, parseNameStatusZ } from "../git/changes.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { agentRepoChanges, anchorOf } from "./agent-changes.js";
import { branchSha, mainBranchOf } from "./agent-refs.js";
import type { IsolatedAgent, PersistedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

// Land a conversation's work into the main tree as UNCOMMITTED changes — the Claude Code review model: the
// agent's finished delta appears in the user's normal Changes panel and their own commit is the review
// boundary. Per repo of the composition: preserve the worktree's dirty state as an agent-authored commit on
// agent/<id> (provenance — nothing is ever lost), take the delta from its anchor to the tip (see anchorOf) as
// a binary rename-aware patch, `git apply --check` it against the main tree, and apply working-tree-only.
// Main's HEAD never moves; landedTip advances so the next land applies only the new delta. A patch that can't
// apply (the user edited the same lines, or an overlapping dirty/untracked path) lands NOTHING for that repo
// and reports it — the worktree keeps everything and "Land now" recovers once the user resolves. Called
// automatically at clean turn completion (streamAgent) and manually from the /agents land route.
//
// The one thing land must never call a conflict is work that ALREADY REACHED the main tree by another road —
// an agent that committed onto the main line itself, a user who committed the branch by hand. It is not a
// state anyone can resolve, and reporting it strands the agent on a red card with nothing to do about it.
// Two independent mechanisms rule it out: anchorOf, when the main line's history contains the work, and the
// reverse probe in classifyDelta, when it holds the CONTENT but not the commits.

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// The wire LandResult plus what the registry persists: `changed` distinguishes "nothing to land" (no frame,
// no status change) from a real outcome, `repos` carries the advanced landedTips, and `diff` is the agent's
// CUMULATIVE anchor→tip output across the composition — the review's own reading of it (agent-changes.ts),
// totalled for the card and independent of how much of it has landed.
export interface LandOutcome extends LandResult {
    readonly changed: boolean;
    readonly repos: PersistedAgent["repos"];
    readonly diff: { files: number; insertions: number; deletions: number };
}

/* Does a patch fit the main tree — and, asked in `reverse`, is it ALREADY IN IT?
 *
 * `git apply --check` answers by exit code, which the runner surfaces as a throw. The reverse question is the
 * one that separates the two ways a patch can fail to apply: content that CLASHES with the main tree, and
 * content the main tree already has. Only the first is a conflict. (Reverse is exact, not a guess: a patch
 * un-applies cleanly precisely when its post-image is what is sitting there — `--binary` emits both
 * directions for binary files for exactly this reason.) */
const applies = async (main: string, patch: string, direction: "forward" | "reverse", git: GitRunner): Promise<boolean> => {
    try {
        await git(main, ["apply", "--check", ...(direction === "reverse" ? ["--reverse"] : []), patch]);
        return true;
    } catch {
        return false;
    }
};

/* ONE CHANGE of a delta, carrying the COMPLETE set of paths its own diff spans.
 *
 * The unit is a CHANGE, not a path, and that distinction is load-bearing rather than tidy: a rename is ONE
 * change across TWO paths, so any git pathspec derived from a delta has to name both. Name the destination
 * alone and `-M` has nothing left to pair — git emits a bare "new file" in place of a rename, and applying
 * THAT creates the destination while leaving the source sitting in the tree.
 *
 * This is not a hypothetical. Reading the delta with `--name-only` (which reports a rename at its destination
 * and nowhere else) is what shipped a land that carried every rename's add and dropped every rename's delete:
 * the main tree ended up holding both halves of each renamed file, the user's commit recorded the stale halves
 * as still-present, and they surfaced later as deletions nobody could attribute to anything.
 */
interface DeltaChange {
    // The destination path — what a conflict report names, because it is the path the user goes looking for.
    readonly path: string;
    // Every path this change's own diff spans: the destination, plus a rename's source.
    readonly paths: readonly string[];
    // What must NOT exist once this change has applied: a deletion's own path, a rename's source.
    readonly removes: readonly string[];
}

// A delta's changes, split by what the main tree makes of each: `clean` is what a land would carry, `blocked` is
// the genuine conflict set. Changes already IN the main tree are in neither — see classifyDelta.
interface DeltaReport {
    readonly blocked: { path: string; reason: LandConflictReason }[];
    readonly clean: DeltaChange[];
}

// A `--name-status` row's path set. `from` is git's rename source; a copy carries none (parseNameStatusZ reports
// it as a plain add, which is what it is for our purposes — the source stays put).
const deltaChangeOf = (change: GitChange): DeltaChange => ({
    path: change.path,
    paths: change.from === undefined ? [change.path] : [change.from, change.path],
    removes: change.status === "deleted" ? [change.path] : change.from === undefined ? [] : [change.from],
});

/* WHICH changes of a delta actually refuse to apply, and why.
 *
 * `git apply` is ATOMIC: one unapplicable file rejects the entire patch. So a failed bulk check says only
 * "something in here does not fit" — it says nothing about WHAT, and the first version of this code guessed,
 * intersecting the delta with the main tree's dirty paths and falling back to naming the whole delta when
 * that intersection came up empty. That fallback fires exactly when the cause is a moved main line, which is
 * the common case, so the common case reported every file as a conflict.
 *
 * Re-checking each change on its own is the only way to tell four real conflicts from the fourteen an atomic
 * failure implicates. Each probe is diffed over that change's WHOLE path set, so rename detection pairs inside
 * it and the probe is the patch shape the real apply will use — a rename probed at its destination alone is a
 * bare creation, which applies cleanly no matter what state the source is in. That made two lies at once: the
 * change was called clean when the user's own edit to the source was in the way, and the "clean" set it joined
 * went on to build a pathspec that could no longer express the rename at all (see DeltaChange).
 *
 * The reverse probe is what keeps ALREADY-LANDED work out of the report. An agent that commits its own delta
 * straight onto the main line — pushing to main, or a user committing the branch by hand — leaves content git
 * cannot recognize as this branch's, because it arrived as a DIFFERENT commit: ancestry says the work is
 * unmerged, so the anchor still spans it and the patch re-offers what the main tree already holds. Every path
 * of it then fails to apply, and reporting that as a conflict is a dead end — there is nothing for the user to
 * resolve and no edit of theirs to point at. Asked in reverse, those paths answer plainly: already here. */
const classifyDelta = async (main: string, from: string, tip: string, patchDir: string, repo: string, git: GitRunner): Promise<DeltaReport> => {
    const rows = parseNameStatusZ((await git(main, ["diff", "--name-status", "-z", "-M", from, tip])).stdout);
    const changes = rows.map(deltaChangeOf);
    // A path the user STAGED conflicts with the incoming patch exactly as much as one they left unstaged, so
    // "yours is the copy at risk" has to consider the union — rename `from` legs included.
    const mainState = await changedFiles(main, git);
    const mainDirty = new Set<string>();
    for (const change of [...mainState.staged, ...mainState.unstaged]) {
        mainDirty.add(change.path);
        if (change.from !== undefined) {
            mainDirty.add(change.from);
        }
    }
    const blocked: { path: string; reason: LandConflictReason }[] = [];
    const clean: DeltaChange[] = [];
    for (const [index, change] of changes.entries()) {
        const single = (await git(main, ["diff", "--binary", "-M", from, tip, "--", ...change.paths])).stdout;
        if (single === "") {
            clean.push(change);
            continue;
        }
        const probePath = join(patchDir, `${repo.replaceAll("/", "_")}.probe.${index}.patch`);
        await writeFile(probePath, single);
        if (await applies(main, probePath, "forward", git)) {
            clean.push(change);
            continue;
        }
        if (await applies(main, probePath, "reverse", git)) {
            // Already in the main tree: not clean (re-applying it would fail) and not a conflict (there is
            // nothing to resolve). It simply drops out of the land — nothing to carry, nothing to report.
            continue;
        }
        // Binary first: it outranks the other two, because no three-way merge of it exists to offer.
        const reason: LandConflictReason = single.includes("GIT binary patch")
            ? "binary"
            : change.paths.some((path) => mainDirty.has(path))
              ? "workspace"
              : "diverged";
        blocked.push({ path: change.path, reason });
    }
    return { blocked, clean };
};

/* Apply exactly `changes` to the main WORKING TREE — the subset land, taken when part of a delta is already in
 * the main tree and only the remainder is genuinely outstanding.
 *
 * Re-diffed over the changes' own paths rather than sliced out of the full patch, so one git invocation keeps
 * rename detection coherent — and it stays coherent only because the pathspec carries BOTH legs of every
 * rename (see DeltaChange). An empty change set therefore has to return early rather than run the diff: a `--`
 * with no paths after it is not an empty pathspec to git, it is NO pathspec, and the subset land would quietly
 * become a whole-delta land including the parts that were excluded on purpose.
 *
 * Then the post-condition, and it lives in here rather than at the call site so the two cannot drift apart: this
 * is the one apply whose patch is built from a pathspec, so it is the one that can under-express the delta, and
 * the way it failed was silent. A tree left holding a file the delta deletes reads as the user's own content —
 * git says nothing, the user's commit records it as present, and it resurfaces days later as a deletion with no
 * author. Finishing the removal is not a guess: the delta is derived from git refs, and a path absent at `tip`
 * is absent. Nor can it collide with something the same set creates — git reports a rename only when the source
 * is gone at `tip`, so a rename's source is never another change's destination.
 */
const applyChanges = async (
    main: string,
    from: string,
    tip: string,
    changes: readonly DeltaChange[],
    patchDir: string,
    repo: string,
    git: GitRunner,
): Promise<void> => {
    if (changes.length === 0) {
        return;
    }
    const patch = (await git(main, ["diff", "--binary", "-M", from, tip, "--", ...changes.flatMap((change) => change.paths)])).stdout;
    if (patch === "") {
        return;
    }
    const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.remainder.patch`);
    await writeFile(patchPath, patch);
    await git(main, ["apply", patchPath]);
    await Promise.all(
        // `force` so an already-absent path — which is all of them, whenever the patch expressed its own
        // removals — costs one stat and no error.
        changes.flatMap((change) => change.removes).map(async (path) => await rm(join(main, path), { force: true })),
    );
};

/* THE REFUSAL AS IT STANDS NOW — the stored conflict report re-asked against today's tree, touching nothing.
 *
 * A land's report is written once, at refusal time, and its sharpest claim rots from under it: `workspace`
 * names the user's uncommitted copy as the thing in the way, and the user clears that by COMMITTING — which
 * no land observes. Served verbatim, the stored report kept saying "commit or stash them" over a spotless
 * tree, and the resolve flow kept refusing to send the agent (a rebase provably cannot reach the user's
 * half, so the web gates on exactly this reason — agentActions.ts) — a dead end whose only exit, another
 * land, is the one thing the message never asks for. The same drift retires rows outright: a main line that
 * has since absorbed or moved past the delta leaves nothing to refuse.
 *
 * So the report is re-derived at read time (agents.routes.ts diff): the land's own anchor, probes and
 * classifier, minus every write. The stored report remains what it honestly is — the EVENT that the last
 * land refused, which is what keeps the card on `conflict` (standing.ts) until a land clears it; its
 * per-path content is what this recomputes. Read-only means no provenance commit, so an attached worktree's
 * uncommitted remainder is not in the span — the recorded refusal's span exactly, since the land that wrote
 * it committed everything first; newer work reshapes the report the way it reshapes everything else: at the
 * next land. */
export const outstandingConflicts = async (worktrees: AgentWorktrees, entry: IsolatedAgent, git: GitRunner = defaultGit): Promise<LandConflict[]> => {
    const conflicts: LandConflict[] = [];
    const patchDir = await mkdtemp(join(tmpdir(), "intentic-classify-"));
    try {
        for (const { repo, base, landedTip } of entry.repos) {
            await worktrees.withRepoLock(repo, async () => {
                const main = worktrees.mainDir(repo);
                if (!(await exists(join(main, ".git")))) {
                    // The main checkout vanished — the same per-repo surface the land itself reports.
                    conflicts.push({ repo, paths: [], clean: 0 });
                    return;
                }
                const attached = await worktrees.attached(entry.id, repo);
                const worktree = worktrees.worktreeDir(entry.id, repo);
                const tip = attached ? (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim() : await branchSha(main, entry.branch, git);
                if (tip === undefined) {
                    return;
                }
                const refDir = attached ? worktree : main;
                const from = await anchorOf(refDir, main, tip, landedTip, base, git);
                if (tip === from) {
                    return;
                }
                const patch = (await git(main, ["diff", "--binary", "-M", from, tip])).stdout;
                if (patch === "") {
                    return;
                }
                const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                await writeFile(patchPath, patch);
                // Applies whole, or is already in whole: nothing refuses today, whatever refused back then.
                if ((await applies(main, patchPath, "forward", git)) || (await applies(main, patchPath, "reverse", git))) {
                    return;
                }
                const report = await classifyDelta(main, from, tip, patchDir, repo, git);
                if (report.blocked.length > 0) {
                    const mainBranch = await mainBranchOf(main, git);
                    conflicts.push({
                        repo,
                        paths: report.blocked,
                        clean: report.clean.length,
                        ...(mainBranch !== undefined ? { mainBranch } : {}),
                    });
                }
            });
        }
    } finally {
        await rm(patchDir, { recursive: true, force: true });
    }
    return conflicts;
};

export const landAgent = async (
    worktrees: AgentWorktrees,
    entry: IsolatedAgent,
    mode: LandMode = "check",
    /* WHICH RUNG THE PATCH IS MEASURED FROM — `outstanding` for every automatic land, and the only reason the
     * other exists is that a land's product is UNCOMMITTED. The user can discard it in the Changes panel like
     * any other change, and when they do, nothing this file records moves: `landedTip` still says the work
     * went in, so the outstanding span is empty and the one action that could put it back would carry an
     * empty patch. `cumulative` re-measures from the branch's own base, which is the only rung that can still
     * see what is gone; classifyDelta's reverse probe drops every path the tree already holds, so what
     * applies is the missing part and nothing else. Offered on the card as "Land again", never automatically:
     * the discard was a decision, and a daemon that undid it in the background would make it meaningless. */
    span: AgentSpan = "outstanding",
    git: GitRunner = defaultGit,
): Promise<LandOutcome> => {
    const conflicts: LandConflict[] = [];
    // Only a `measure` land sets this: an outstanding delta it deliberately left on the branch (see LandModeSchema).
    let held = false;
    // Only a `merge` land fills this: the paths now sitting in the workspace with conflict markers on them.
    const resolving: { repo: string; paths: string[] }[] = [];
    const repos: PersistedAgent["repos"] = [];
    const diff = { files: 0, insertions: 0, deletions: 0 };
    let changed = false;
    // One temp dir for the run's patch files, removed whole in the finally.
    const patchDir = await mkdtemp(join(tmpdir(), "intentic-land-"));
    try {
        for (const composed of entry.repos) {
            const { repo, base } = composed;
            let next: PersistedAgent["repos"][number] = composed;
            await worktrees.withRepoLock(repo, async () => {
                const main = worktrees.mainDir(repo);
                if (!(await exists(join(main, ".git")))) {
                    // The main checkout vanished — nothing to apply into; surfaced, not silently skipped. No
                    // path-level account exists for it, which is what an empty `paths` with nothing clean says.
                    conflicts.push({ repo, paths: [], clean: 0 });
                    changed = true;
                    return;
                }
                /* Which checkout answers for the branch. A retired one (an archived agent, or a restored one
                 * whose next turn hasn't re-attached it yet) is NOT "nothing to land": the branch still holds
                 * everything — retire commits the worktree's remainder before reclaiming it — and the shared
                 * object store makes all of it readable from the main repo. Skipping here was how landing an
                 * archived agent "succeeded" while landing nothing, and stamped the card Landed over a review
                 * still counting every file as pending. */
                const attached = await worktrees.attached(entry.id, repo);
                const worktree = worktrees.worktreeDir(entry.id, repo);
                // 1. Preserve the worktree's uncommitted state as an agent-authored commit on its branch —
                // staged, unstaged and untracked alike (`add -A` sweeps all three), and a no-op when staging
                // leaves the index empty. That last case is the ROOT repo of a workspace whose only change
                // lives inside a NESTED repo of the composition: root sees "modified: <repo> (modified
                // content)" but can stage nothing, because a gitlink moves only when that repo's own HEAD
                // does. The nested repo lands its own work below; root's gitlink follows whenever someone
                // commits there. (A retired checkout has nothing uncommitted to preserve — its retire did this.)
                if (attached) {
                    await gitCommitAll(worktree, `Agent: ${entry.title ?? entry.id}`, AGENT_GIT_AUTHOR, git);
                }
                const tip = attached ? (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim() : await branchSha(main, entry.branch, git);
                if (tip === undefined) {
                    return;
                }
                // Ref-only reads run wherever the refs live: the worktree while attached, the main repo after.
                const refDir = attached ? worktree : main;
                /* The card's counter, totalled over the very rows the REVIEW lists (agent-changes.ts) — the
                 * agent's cumulative output, landed work included. Read here because a land is where a turn's
                 * work becomes final and the shas are already in hand, but computed by the review's own
                 * reader: a second, independent diffstat is how the card came to claim 336 files over a review
                 * showing 6, having measured from the frozen base while the review measured from the anchor. */
                for (const change of await agentRepoChanges(worktrees, entry, composed, "cumulative", git)) {
                    diff.files += 1;
                    diff.insertions += change.additions ?? 0;
                    diff.deletions += change.deletions ?? 0;
                }
                const from = await anchorOf(refDir, main, tip, span === "cumulative" ? undefined : composed.landedTip, base, git);
                if (tip === from) {
                    /* Everything already landed for this repo. Usually that is a recorded fact (landedTip is
                     * the tip) and this land is a true no-op — but when ANCESTRY says so, the registry is
                     * hearing it for the first time: the main line merged the branch, or fast-forwarded onto
                     * it, since the last land — an agent told to "land on main" that ran the merge itself.
                     * That is a real outcome and must be persisted like one: with landedTip left behind, the
                     * review re-offers the whole delta as "not landed" forever and a conflict report from
                     * before the merge never clears. No landedHead/landedAt, as with the net-zero delta:
                     * nothing here arrived as uncommitted content to attribute. */
                    if ((composed.landedTip ?? base) !== tip) {
                        next = { repo, base, landedTip: tip };
                        changed = true;
                    }
                    return;
                }
                changed = true;
                // How this delta gets marked accounted-for — every ending below that puts it in the main tree
                // finishes here. `landedTip` stops it being re-offered; `landedHead`/`landedAt` record where the
                // main tree stood when it went in. That stamp dates the per-file attribution the Changes
                // panel draws: while HEAD still stands here, this agent's delta IS part of the repo's
                // uncommitted content, so those paths can be credited to it. Once the user commits, HEAD moves
                // and the claim expires rather than following a path they may since have re-edited themselves
                // (agents/origins.ts). An unborn HEAD records none, and claims nothing.
                const advanced = async (): Promise<PersistedAgent["repos"][number]> => {
                    const landedHead = await headSha(main, git);
                    return { repo, base, landedTip: tip, ...(landedHead !== undefined ? { landedHead } : {}), landedAt: Date.now() };
                };
                // 2. Patch-apply the delta onto the main WORKING TREE only — no index, no commit: the result
                // is plain unstaged changes, exactly what the Changes panel reviews. `apply --check` is the
                // conflict gate, and it is CONTEXT-based, which is what makes incremental landing work: a
                // main file still holding the previously-landed (`from`) content matches the patch context and
                // applies cleanly, while a user edit on the same lines mismatches and applies NOTHING. A
                // path-set overlap test can't make that distinction (it would flag every re-touched file).
                const patch = (await git(main, ["diff", "--binary", "-M", from, tip])).stdout;
                if (patch === "") {
                    // A net-zero delta — the agent reverted everything it did since the last land. There is
                    // nothing to apply (`git apply` rejects an empty patch), but the tip must still advance,
                    // or every future land re-reports this range as a phantom conflict nothing can resolve.
                    // No provenance: nothing of this agent's is in the main tree to attribute.
                    next = { repo, base, landedTip: tip };
                    return;
                }
                const patchPath = join(patchDir, `${repo.replaceAll("/", "_")}.patch`);
                await writeFile(patchPath, patch);
                /* `measure`: auto-land is off, so an outstanding delta STAYS on the branch — everything above
                 * this line already ran (the provenance commit, the diffstat, the tip===from and net-zero
                 * bookkeeping), and everything below is exactly what "don't touch the main tree" forbids. The
                 * one question still worth asking is the reverse probe: a delta that un-applies cleanly is
                 * already sitting in the main tree by another road (the agent committed onto the main line
                 * itself, a user applied the branch by hand), and holding THAT "ready to land" would offer a
                 * land that can never do anything — so it advances like any other already-in-main outcome.
                 * Anything else is genuinely outstanding: held, tips untouched, and the eventual deliberate
                 * land runs the full conflict gate on the cumulative delta. */
                if (mode === "measure") {
                    if (await applies(main, patchPath, "reverse", git)) {
                        next = await advanced();
                        return;
                    }
                    held = true;
                    return;
                }
                if (!(await applies(main, patchPath, "forward", git))) {
                    const report = await classifyDelta(main, from, tip, patchDir, repo, git);
                    /* NOTHING here is in conflict — the atomic check failed only because part of this delta is
                     * already in the main tree. That is a land, not a refusal: apply whatever is genuinely
                     * outstanding (nothing at all, when the agent put its whole delta on the main line itself)
                     * and advance, so the work stops being re-offered on every future land. */
                    if (report.blocked.length === 0) {
                        await applyChanges(main, from, tip, report.clean, patchDir, repo, git);
                        next = await advanced();
                        return;
                    }
                    /* A three-way apply merges THROUGH THE INDEX, so git refuses it outright — applying not
                     * one file, not even the clean ones — as soon as any path it must fall back on differs
                     * between the working tree and the index ("does not match index"). That is precisely the
                     * `workspace` cause. So merge mode is offered only where git can actually merge: the
                     * user's own uncommitted copy has to be committed or stashed first, and saying so beats
                     * attempting it and reporting a failure they cannot read. */
                    const mergeable = report.blocked.every((conflict) => conflict.reason !== "workspace");
                    if (mode === "check" || !mergeable) {
                        // What `check` promises is that a refusal leaves the workspace byte-identical. Report
                        // and stop: the worktree keeps everything, and "Land now" recovers once the user acts.
                        // Only `blocked` is reported: an already-in-main path is not something to resolve.
                        const mainBranch = await mainBranchOf(main, git);
                        conflicts.push({
                            repo,
                            paths: report.blocked,
                            clean: report.clean.length,
                            ...(mainBranch !== undefined ? { mainBranch } : {}),
                        });
                        return;
                    }
                    /* `merge`: the user has read the report and asked for the three-way anyway. Every clean
                     * path lands, and each conflicted one arrives carrying the standard markers to be finished
                     * in place — the shape any merge leaves behind, in the editor they already use.
                     *
                     * `--3way` exits non-zero precisely BECAUSE it left conflicts, so a throw here is the
                     * intended outcome rather than a failure; the delta is in the tree either way. It needs
                     * both blobs to merge against, which the object store shared with the worktree has. */
                    try {
                        await git(main, ["apply", "--3way", patchPath]);
                    } catch {
                        // Nothing to add: `report` already names what was left open, and it is reported below.
                    }
                    resolving.push({ repo, paths: report.blocked.map((conflict) => conflict.path) });
                    // The tip advances even with paths still open, because the delta IS in the main tree now.
                    // Holding it back would re-apply the whole thing over the user's half-finished resolution
                    // the next time anything lands.
                    next = await advanced();
                    return;
                }
                await git(main, ["apply", patchPath]);
                next = await advanced();
            });
            repos.push(next);
        }
    } finally {
        await rm(patchDir, { recursive: true, force: true });
    }
    return {
        // A held delta is not landed — but a conflict is the louder fact, so `held` reports only when it is
        // the outcome (the wire contract: held ⇒ nothing was applied and nothing failed).
        landed: conflicts.length === 0 && !held,
        changed,
        repos,
        diff,
        ...(conflicts.length > 0 ? { conflicts } : {}),
        ...(resolving.length > 0 ? { resolving } : {}),
        ...(held && conflicts.length === 0 ? { held: true } : {}),
    };
};
