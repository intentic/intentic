import type { GitRunner } from "@intentic/base/git";

// Where a land moved the folders it renamed, read off its delta: what the files an ignore rule hid there follow
// (unhidden.ts). Only exact renames vote, paired by blob: a deleted file and an added one holding the same bytes. Two
// renamed files `a/web/src/x.rs` -> `b/web/src/x.rs` say `a/` moved to `b/`: the paths' longest shared tail is what moved
// with the folder, and what stands before it on each side is the folder's old and new place.

export interface FolderMove {
    // Both end in a slash; `to` is empty for a folder moved to the repository's top.
    readonly from: string;
    readonly to: string;
    // How many renamed files say so.
    readonly votes: number;
}

const ZERO_SHA = /^0+$/;

// `diff --raw -z` records: `:mode mode sha sha status\0path\0`, renames off, so every move is one D and one A.
const sidesOf = (stdout: string) => {
    const gone = new Map<string, string[]>();
    const came = new Map<string, string[]>();
    const fields = stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const [, , before, after, status] = (fields[index] ?? "").split(" ");
        const path = fields[index + 1] ?? "";
        const side = status === "D" ? gone : status === "A" ? came : undefined;
        const sha = status === "D" ? before : after;
        if (side === undefined || sha === undefined || ZERO_SHA.test(sha) || path === "") {
            continue;
        }
        side.set(sha, [...(side.get(sha) ?? []), path]);
    }
    return { gone, came };
};

// The folder move one rename pair says, or undefined when it moved a file within its folder or out of the top.
const moveOf = (before: string, after: string): { readonly from: string; readonly to: string } | undefined => {
    const old = before.split("/");
    const now = after.split("/");
    let shared = 0;
    while (shared < old.length && shared < now.length && old[old.length - 1 - shared] === now[now.length - 1 - shared]) {
        shared += 1;
    }
    if (shared === 0 || shared >= old.length) {
        return undefined;
    }
    const from = `${old.slice(0, old.length - shared).join("/")}/`;
    const to = now.length === shared ? "" : `${now.slice(0, now.length - shared).join("/")}/`;
    return from === to ? undefined : { from, to };
};

// Every folder move the delta from..tip makes, most votes first. A blob several files share (an empty file, a licence
// copied around) pairs nothing: which went where is not knowable from it.
export const folderMoves = async (main: string, from: string, tip: string, git: GitRunner): Promise<readonly FolderMove[]> => {
    const { stdout } = await git(main, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "--diff-filter=AD", from, tip]);
    const { gone, came } = sidesOf(stdout);
    const votes = new Map<string, FolderMove>();
    for (const [sha, [before, ...moreGone]] of gone) {
        const [after, ...moreCame] = came.get(sha) ?? [];
        const move = before === undefined || after === undefined || moreGone.length > 0 || moreCame.length > 0 ? undefined : moveOf(before, after);
        if (move !== undefined) {
            const key = `${move.from}\0${move.to}`;
            votes.set(key, { ...move, votes: (votes.get(key)?.votes ?? 0) + 1 });
        }
    }
    return [...votes.values()].toSorted((a, b) => b.votes - a.votes || b.from.length - a.from.length);
};

// Where `path` would sit after each move that carries it, most likely first.
export const destinationsOf = (path: string, moves: readonly FolderMove[]): { readonly to: string; readonly move: FolderMove }[] =>
    moves.filter((move) => path.startsWith(move.from)).map((move) => ({ to: `${move.to}${path.slice(move.from.length)}`, move }));
