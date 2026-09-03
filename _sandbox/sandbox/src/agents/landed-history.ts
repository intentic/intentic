import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* WHERE IN YOUR OWN HISTORY AN AGENT'S WORK ENDED UP, the question that only exists once the answer to "does
 * this still differ from main?" is no.
 *
 * A land puts its delta in the main WORKING TREE (land.ts); the user reviews it in the Changes panel and
 * commits it, and at that moment the agent's rows leave the review for good: they are not a difference against
 * main any more, so `presentInMain` reports them ABSORBED and the panel drops them (agent-changes.ts states
 * the three-state rule and why). What was left behind was a dead end, one sentence saying the work is "in your
 * workspace's history" over a panel with nothing in it, at the exact moment a reader had come to look at what
 * the agent did.
 *
 * The work is findable, and cheaply, because absorption is a CONTENT fact rather than a bookkeeping one. A
 * path is absorbed precisely when main's HEAD tree and the agent's branch agree on it, so the newest commit in
 * the span that touched that path is the commit that left the agent's bytes there. Two things pin the span:
 *
 *   - `landedHead`, on the registry row (agents-store.ts), is where main's HEAD stood when the patch went in,
 *     so nothing before it can be the commit that took this work. It is the same near end the per-path expiry
 *     is anchored at, and for the same reason (origins.ts spells it out at length).
 *   - HEAD is the far end, since a commit is what absorbs.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It says which commits CARRY the work, not which commit authored it.
 * A file committed with the agent's content and then reverted and re-committed elsewhere is attributed to the
 * newest commit that left that content, which is the honest answer to "where do I read this now" and not
 * necessarily the answer to "who typed it". The distinction matters for one case only, and in that case the
 * newest commit is still where the reader should be sent.
 *
 * A path the span cannot account for is REPORTED, never guessed at: content reaches main by roads that do not
 * pass through a commit in this span (a cherry-pick from elsewhere, a second agent landing the same lines, the
 * user typing them by hand before the land). Those are absorbed and unattributable at once, and saying so is
 * the difference between a surface that is trusted and one that is checked. */

export interface HistoryCommit {
    readonly sha: string;
    readonly short: string;
    readonly subject: string;
    readonly author: string;
    // Author time in ms, the unit every other timestamp on this wire uses (commitLog converts the same way).
    readonly at: number;
    // The asked-about paths this commit is the newest carrier of. Disjoint across the returned commits, so the
    // counts a reader adds up cannot exceed the work.
    readonly paths: readonly string[];
}

/* Pathspecs go in argv, so a landing of several hundred files would otherwise be one enormous command line.
 * The same bound, for the same reason, as the hash probe in agent-changes.ts. A commit spanning two chunks
 * comes back twice and is merged by sha below. */
const PATH_CHUNK = 100;

// `git merge-base --is-ancestor` answers by exit code, which the runner surfaces as a throw. Same shape as
// agent-changes.ts's own, kept local rather than shared: that one is about a branch tip, this one is about a
// recorded head, and folding them would put a general helper between two callers that mean different things.
const isAncestor = async (dir: string, ancestor: string, descendant: string, git: GitRunner): Promise<boolean> => {
    try {
        await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
};

/* THE NEAR END OF THE SPAN, which is `landedHead` whenever it is still on the main line and something honest
 * whenever it is not.
 *
 * `landedHead` stops being an ancestor the moment main's history is rewritten under it, an amend, a rebase, a
 * reset, all of which are ordinary things for a user to do to their own branch between committing an agent's
 * work and coming back to look at it. Diffing from a sha that is no longer on the branch would range over both
 * sides of the divergence and name commits that were never in this history at all, so the merge-base is taken
 * instead: it is the newest commit the two still agree on, which is the tightest span that is certainly ours.
 *
 * Unresolvable ⇒ undefined, and the caller answers with nothing rather than with a guess. Being wrong here is
 * pointing a reader at somebody else's commit, which is worse than the empty state this replaces. */
export const historySpanStart = async (dir: string, landedHead: string, head: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    if (await isAncestor(dir, landedHead, head, git)) {
        return landedHead;
    }
    try {
        const merged = (await git(dir, ["merge-base", landedHead, head])).stdout.trim();
        return merged === "" ? undefined : merged;
    } catch {
        // A pruned object or an unrelated history: the same verdict origins.ts reaches for the same shas, and
        // the same outcome, this landing simply goes unattributed.
        return undefined;
    }
};

/* One `git log` record: the commit's own fields, then the paths it touched. `-z` makes this parseable without
 * quoting rules, git terminates the format output with NUL and then each path with NUL (a lone newline sits
 * between the two, which is git's own separator and is stripped here).
 *
 * `--format=` AND NOT `--pretty=format:`, which are not the same flag however much they read like it: the
 * second is SEPARATOR semantics, so git writes its terminator BETWEEN records and not after each one, and
 * under `-z` that means the NUL closing the header is simply absent. The first path then arrives glued to the
 * subject with a newline between them, every record loses one file, and a commit with one file loses its only
 * one and drops out of the answer entirely. `--format=` is terminator semantics and closes every header.
 *
 * `--full-history` because the default simplification PRUNES commits: asked about a path, git is entitled to
 * drop a commit whose change came to nothing along one parent, and a commit dropped here is a commit the
 * reader is not shown. `--diff-merges=first-parent` because a merge shows no diff at all by default, so a
 * landing absorbed by merging a side branch would report as unaccounted; first-parent is the same convention
 * `commitChanges` reads a commit's own files by. */
const RS = "\x1e";
const US = "\x1f";

const parseRecord = (record: string): { commit: Omit<HistoryCommit, "paths">; paths: readonly string[] } | undefined => {
    const [header, ...rest] = record.split("\0");
    if (header === undefined) {
        return undefined;
    }
    const fields = header.split(US);
    if (fields.length < 5) {
        return undefined;
    }
    const [sha, short, author, at] = fields;
    if (sha === undefined || sha === "") {
        return undefined;
    }
    return {
        // The subject is last, so anything in it that looks like a separator is joined back on rather than
        // truncating the message, which is what commitLog does with the same format for the same reason.
        commit: { sha, short: short ?? "", subject: fields.slice(4).join(US), author: author ?? "", at: Number(at ?? "0") * 1000 },
        // Every path is its own allocation, never a slice of the record: these outlive the call frame in the
        // response, and a sliced path pins the whole log output (see git/changes.ts materializedPaths).
        paths: rest.map((path) => Buffer.from(path.startsWith("\n") ? path.slice(1) : path, "utf8").toString("utf8")).filter((path) => path !== ""),
    };
};

/* THE COMMITS THAT CARRY THESE PATHS, newest first, each holding only the paths it is the NEWEST carrier of.
 *
 * The one-carrier-per-path rule is what makes the result addable: a path claimed by the newest commit that
 * names it is claimed nowhere else, so the counts a panel renders ("8 of 12 files") sum to the work rather
 * than over-counting every file a busy branch touched twice. A commit every one of whose paths was claimed by
 * something newer drops out entirely, because there is nothing left for it to tell the reader.
 *
 * `paths` is expected to be the ABSORBED set (agent-changes.ts presentInMain): asking this about paths that
 * still differ from main would name whatever last touched them, which is the user's own unrelated work. */
export const commitsCarrying = async (
    dir: string,
    from: string,
    head: string,
    paths: readonly string[],
    git: GitRunner = defaultGit,
): Promise<readonly HistoryCommit[]> => {
    if (paths.length === 0) {
        return [];
    }
    const format = `${RS}%H${US}%h${US}%an${US}%at${US}%s`;
    // Insertion order is git's own (newest first) within a chunk, and chunks are walked in order, so a commit
    // first seen in a later chunk still lands after the ones above it. Ordering is settled once, below.
    const order: string[] = [];
    const commits = new Map<string, Omit<HistoryCommit, "paths">>();
    const touched = new Map<string, string[]>();
    for (let cursor = 0; cursor < paths.length; cursor += PATH_CHUNK) {
        const { stdout } = await git(dir, [
            "log",
            "--full-history",
            "--diff-merges=first-parent",
            "--name-only",
            "-z",
            `--format=${format}`,
            `${from}..${head}`,
            "--",
            ...paths.slice(cursor, cursor + PATH_CHUNK),
        ]);
        for (const record of stdout.split(RS)) {
            const parsed = record === "" ? undefined : parseRecord(record);
            if (parsed === undefined) {
                continue;
            }
            if (!commits.has(parsed.commit.sha)) {
                commits.set(parsed.commit.sha, parsed.commit);
                order.push(parsed.commit.sha);
            }
            const seen = touched.get(parsed.commit.sha);
            if (seen === undefined) {
                touched.set(parsed.commit.sha, [...parsed.paths]);
                continue;
            }
            seen.push(...parsed.paths);
        }
    }
    /* Newest carrier wins, decided in one pass down the ordered commits: the first commit to name a path keeps
     * it, and `claimed` is what makes every later mention of it a no-op. The pathspec means every path named
     * here is one that was asked about, so nothing has to be filtered against the input again. */
    const claimed = new Set<string>();
    const carried: HistoryCommit[] = [];
    for (const sha of order) {
        const commit = commits.get(sha);
        if (commit === undefined) {
            continue;
        }
        const mine = (touched.get(sha) ?? []).filter((path) => !claimed.has(path));
        if (mine.length === 0) {
            continue;
        }
        for (const path of mine) {
            claimed.add(path);
        }
        carried.push({ ...commit, paths: mine });
    }
    return carried;
};
