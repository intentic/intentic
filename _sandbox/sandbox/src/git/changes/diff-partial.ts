import type { PartialFileDiff } from "@intentic/sandbox-contract";

// The answer for a file too big to ship as two whole sides: git computes a unified patch of the changed regions
// (bounded to MAX_PATCH_BYTES) instead of sending both sides whole; nothing here reads the file itself.

// Size cap before a file-diff surface ships a side whole; past it, the patch below is smaller and more useful.
export const MAX_FILE_DIFF_BYTES = 512 * 1024;

// Max wire size for one patch; a rewrite past this is cut at a region boundary and flagged.
export const MAX_PATCH_BYTES = 256 * 1024;

// unified=3 mirrors DiffView's CONTEXT_LINES; no-ext-diff/no-textconv force a plain unified patch.
const PATCH_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3"] as const;

// Git's binary verdict; the only way to learn an oversized, unread file is actually binary.
const BINARY_LINE = /^Binary files .* differ$/m;

// The `@@` sections of a patch, or undefined if git produced none (identical sides or binary). Stops at a second file's
// header.
const hunkBody = (stdout: string): string | undefined => {
    const lines = stdout.split("\n");
    const first = lines.findIndex((line) => line.startsWith("@@ "));
    if (first === -1) {
        return undefined;
    }
    const next = lines.findIndex((line, index) => index > first && line.startsWith("diff --git "));
    return lines.slice(first, next === -1 ? undefined : next).join("\n");
};

// Cuts to the budget at a region boundary, or at a line when a single region (an add/delete) exceeds it; `more` flags
// either cut.
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

// What the caller's own size checks couldn't tell it: whether the file is binary, and the partial diff to send instead
// of both sides.
export interface PartialDiffResult {
    readonly binary: boolean;
    readonly partial: PartialFileDiff;
}

// An untracked file is invisible to `git diff` (no index or tree entry), so its patch is written here as pure additions
// from `head`, a line-trimmed prefix (`whole` says if it reached the end).
export const additionPatch = (head: string, whole: boolean): { readonly patch: string; readonly more: boolean } => {
    const rows = (head.endsWith("\n") ? head.slice(0, -1) : head).split("\n");
    const cut = clip(`@@ -0,0 +1,${rows.length} @@\n${rows.map((line) => `+${line}`).join("\n")}`);
    return { patch: cut.patch, more: cut.more || !whole };
};

// `tail` (the rev-spec/path args) is the caller's to build, since only it knows the row's comparison. On any refusal
// (git error, output overflow) this degrades to sizes alone rather than throwing.
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
