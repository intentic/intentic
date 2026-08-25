import type { PartialFileDiff } from "@intentic/sandbox-contract";

/* THE ANSWER FOR A FILE TOO BIG TO SHIP AS TWO WHOLE SIDES, shared by every diff surface the daemon serves:
 * the working tree, an agent's review, a commit in the graph, a checkpoint.
 *
 * Above MAX_FILE_DIFF_BYTES the sides are not sent, and for a long time nothing was: the response said "too
 * large" and the browser printed one sentence over an empty pane. But the size of a FILE is not the size of
 * its CHANGE, and the change is the whole reason a reviewer opened it. So the daemon asks git for the change
 * and ships that: a unified patch of the changed regions, bounded to MAX_PATCH_BYTES, which stands in for a
 * pair of sides that could run to hundreds of megabytes.
 *
 * Only the `@@` sections travel. Git's file headers above them name rev-specs (`a/HEAD:src/x.ts`) that no one
 * can apply the patch to anyway, and the client addresses hunks by the line numbers in the headers.
 *
 * NOTHING HERE READS THE FILE. That is the point of using git rather than diffing two strings in the daemon:
 * the sides never enter this process's heap, which is precisely what the size cap was protecting. */

// The text cap every file-diff surface applies before it will ship a side whole. Half a megabyte is already a
// megabyte of JSON for a two-sided diff, and past it the patch below is both smaller and more useful.
export const MAX_FILE_DIFF_BYTES = 512 * 1024;

// What one patch may weigh on the wire. Generous next to a real change (a hundred edited lines is a few KB)
// and small next to the file it replaces; a rewrite that blows past it is cut at a region boundary and says so.
export const MAX_PATCH_BYTES = 256 * 1024;

/* Unchanged lines kept either side of a change. The SAME number the browser's diff panes keep around a
 * collapsed region (DiffView's CONTEXT_LINES), so a patched-in diff reads exactly like a whole-file one, and
 * `--no-ext-diff`/`--no-textconv` because a user's configured differ or textconv filter would answer with
 * something that is not a unified patch at all. */
const PATCH_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3"] as const;

// git's verdict when a side holds NUL bytes. It reaches this module only for an oversized file, whose bytes
// were never read, so this is the one chance to learn that a 4 MB "text" file is really a screenshot.
const BINARY_LINE = /^Binary files .* differ$/m;

// The `@@` sections of a patch, or undefined when git produced none (identical sides, or a binary verdict).
// Stops at a second file's header, which one path can't produce but costs nothing to refuse.
const hunkBody = (stdout: string): string | undefined => {
    const lines = stdout.split("\n");
    const first = lines.findIndex((line) => line.startsWith("@@ "));
    if (first === -1) {
        return undefined;
    }
    const next = lines.findIndex((line, index) => index > first && line.startsWith("diff --git "));
    return lines.slice(first, next === -1 ? undefined : next).join("\n");
};

/* Cut to the budget at a REGION boundary, so what arrives is a whole number of changes rather than a hunk
 * that stops mid-thought. The exception is a single region bigger than the budget, which is what an added or
 * deleted file is: there is no earlier boundary to fall back to, so it is cut at a line instead and the reader
 * gets the head of the file. Either way `more` says the cut happened, and the client's parser counts the lines
 * it actually receives rather than trusting the hunk header's totals, so a clipped region still numbers right. */
const clip = (body: string): { readonly patch: string; readonly more: boolean } => {
    if (Buffer.byteLength(body, "utf8") <= MAX_PATCH_BYTES) {
        return { patch: body, more: false };
    }
    const lines = body.split("\n");
    let used = 0;
    let taken = 0;
    let boundary = 0;
    for (const [index, line] of lines.entries()) {
        const cost = Buffer.byteLength(line, "utf8") + 1;
        if (used + cost > MAX_PATCH_BYTES) {
            break;
        }
        used += cost;
        taken = index + 1;
        if (index > 0 && line.startsWith("@@ ")) {
            boundary = index;
        }
    }
    return { patch: lines.slice(0, boundary > 0 ? boundary : taken).join("\n"), more: true };
};

// What the caller learned that its own size checks could not: whether the oversized file is binary after all,
// and the partial diff to send in place of the two sides.
export interface PartialDiffResult {
    readonly binary: boolean;
    readonly partial: PartialFileDiff;
}

/* THE ONE FILE GIT CANNOT DIFF: one with no counterpart and no object either, which is what an UNTRACKED file
 * is. `git diff` compares the index and the tree, and a path in neither is invisible to it, so asking would
 * come back empty and an oversized dropped dataset (or a bundle an agent has just written) would land on the
 * dead end this whole module exists to remove.
 *
 * It needs no diffing anyway: with no before side, the file IS the change, so its patch is its lines as
 * additions and a head of it is what the budget affords. Written here rather than asked for, in the shape git
 * would have printed, so the browser still has exactly one thing to parse.
 *
 * `head` is a line-boundary-trimmed prefix of the file's text and `whole` says it reached the end; the clip
 * below is what keeps the `+` prefixes from carrying the result past the budget the read was sized for. */
export const additionPatch = (head: string, whole: boolean): { readonly patch: string; readonly more: boolean } => {
    const rows = (head.endsWith("\n") ? head.slice(0, -1) : head).split("\n");
    const cut = clip(`@@ -0,0 +1,${rows.length} @@\n${rows.map((line) => `+${line}`).join("\n")}`);
    return { patch: cut.patch, more: cut.more || !whole };
};

/* One oversized file's diff, from whichever git the caller runs. `tail` is the rev-spec/path half of the
 * command, and it is the CALLER's to build because only the caller knows which comparison its row is listed
 * under: `["--cached", "--", path]` is a staged row, `[base, tip, "--", path]` an archived agent's, and
 * getting that wrong would show a reviewer a diff they never asked for.
 *
 * A refusal (git errored, or the patch outgrew the runner's output buffer) degrades to the sizes alone rather
 * than throwing: the diff still opens, and the surface says how big the thing it cannot render is, which is
 * strictly more than the empty pane this replaced. */
export const partialDiff = async (
    run: (args: readonly string[]) => Promise<string>,
    tail: readonly string[],
    sizes: { readonly before: number | undefined; readonly after: number | undefined },
): Promise<PartialDiffResult> => {
    const bytes: PartialFileDiff = {
        ...(sizes.before !== undefined ? { beforeBytes: sizes.before } : {}),
        ...(sizes.after !== undefined ? { afterBytes: sizes.after } : {}),
    };
    let stdout: string;
    try {
        stdout = await run([...PATCH_ARGS, ...tail]);
    } catch {
        return { binary: false, partial: bytes };
    }
    const body = hunkBody(stdout);
    if (body === undefined) {
        return { binary: BINARY_LINE.test(stdout), partial: bytes };
    }
    const { patch, more } = clip(body);
    return { binary: false, partial: { ...bytes, patch, ...(more ? { more: true } : {}) } };
};
