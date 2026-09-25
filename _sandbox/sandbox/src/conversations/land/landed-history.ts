import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { isAncestor } from "./agent-refs.js";

// Where absorbed agent work landed in the user's own history: once a path's content matches main's HEAD
// (agent-changes.ts presentInMain), the newest commit in landedHead..HEAD to touch it is reported as the carrier, not
// necessarily the author. A path the span can't account for is reported, never guessed at.

export interface HistoryCommit {
    readonly sha: string;
    readonly short: string;
    readonly subject: string;
    readonly author: string;
    // Author time in ms, the unit every timestamp on this wire uses (commitLog converts the same way).
    readonly at: number;
    // Paths this commit is the newest carrier of; disjoint across returned commits, so counts sum to the work.
    readonly paths: readonly string[];
}

// Chunked so a large landing's pathspecs don't become one giant argv; a commit spanning chunks is merged by sha below.
const PATH_CHUNK = 100;

// landedHead if still an ancestor of head; otherwise the merge-base, the newest commit a rewritten main (amend, rebase)
// still shares with it. Unresolvable returns undefined, never a guess.
export const historySpanStart = async (dir: string, landedHead: string, head: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    if (await isAncestor(dir, landedHead, head, git)) {
        return landedHead;
    }
    try {
        const merged = (await git(dir, ["merge-base", landedHead, head])).stdout.trim();
        return merged === "" ? undefined : merged;
    } catch {
        // A pruned object or unrelated history: same verdict origins.ts reaches, so this landing goes unattributed.
        return undefined;
    }
};

// One `git log` record, NUL-separated header then paths (`-z`); the header must end in NUL too.
// - `--format=`, not `--pretty=format:`: the latter drops the header's closing NUL, losing each commit's first path
// - `--full-history` since default simplification prunes commits; `--diff-merges=first-parent` covers merged-in work
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
        // Subject is last, so anything in it resembling a separator joins back on instead of truncating the message.
        commit: { sha, short: short ?? "", subject: fields.slice(4).join(US), author: author ?? "", at: Number(at ?? "0") * 1000 },
        // Each path is its own allocation, not a record slice: these outlive the call frame (materializedPaths).
        paths: rest.map((path) => Buffer.from(path.startsWith("\n") ? path.slice(1) : path, "utf8").toString("utf8")).filter((path) => path !== ""),
    };
};

// Each commit holds only the paths it's the newest carrier of, so counts across commits sum to the work, not
// double-count. `paths` must already be the absorbed set.
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
    // Newest-first within each chunk; first-seen across chunks decides precedence (settled below).
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
    // First commit to name a path keeps it; `claimed` makes every later mention a no-op.
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
