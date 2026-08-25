/* A UNIFIED PATCH, TURNED BACK INTO TWO SIDES A DIFF EDITOR CAN HOLD.
 *
 * The daemon refuses to ship both whole sides of a huge file and sends its changed regions as a patch instead
 * (sandbox: git/diff-partial.ts). This is the other half of that bargain: rather than render the patch as the
 * plain text it is, in a viewer nothing else in the product uses, it is unpicked into a before and an after,
 * and those go into the SAME Monaco diff every other file gets. Syntax colour, split or inline, next/previous
 * change, the minimap, the comment toggle: all of it comes for free, and a 60 MB file reviews exactly like a
 * 6 KB one.
 *
 * TWO THINGS MAKE THAT HONEST rather than a trick.
 *
 * The line numbers are the FILE's, not the model's: a hunk at line 4,182 says 4,182 in the gutter, because the
 * hunk header carries where it came from and DiffView can render a gutter from a lookup (it already does, for
 * the comment strip). Numbering these panes 1..n would be a quiet lie about a file the reader cannot open.
 *
 * And the joins are VISIBLE. Two regions a thousand lines apart end up adjacent in the model, so a gap marker
 * goes between them, on both sides at once, which is what keeps Monaco treating it as an unchanged line and
 * the two panes aligned across it. */

// The stand-in for the lines between two regions. On both sides, so the diff engine sees an unchanged line and
// the panes stay aligned; blank in the gutter, because it is not a line of the file.
export const PATCH_GAP = "⋯";

export interface PatchedSides {
    readonly before: string;
    readonly after: string;
    /* Where each model line came from in the real file, 1-based, indexed by (model line − 1). 0 is a gap
     * marker, which came from nowhere. Handed to DiffView as its gutter. */
    readonly beforeLines: readonly number[];
    readonly afterLines: readonly number[];
    // How many changed regions the patch held: what the notice above the panes counts.
    readonly regions: number;
}

// `@@ -<start>[,<count>] +<start>[,<count>] @@[ heading]`. Only the two STARTS are read: the counts describe
// what git produced, and a patch clipped to a byte budget may hold fewer lines than its last header claims.
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/* Rebuild the two sides. `more` says the daemon cut the patch short, which is the one case where a marker
 * belongs after the last region as well as between them: everywhere else a trailing marker would be a claim
 * about the end of the file that a patch cannot support.
 *
 * undefined when there are no regions at all, a patch of nothing to show, which the caller renders as the
 * "nothing we can draw" state rather than as two empty panes. */
export const patchedSides = (patch: string, more = false): PatchedSides | undefined => {
    const before: string[] = [];
    const after: string[] = [];
    const beforeLines: number[] = [];
    const afterLines: number[] = [];
    let beforeAt = 0;
    let afterAt = 0;
    let regions = 0;

    const gap = (): void => {
        before.push(PATCH_GAP);
        after.push(PATCH_GAP);
        beforeLines.push(0);
        afterLines.push(0);
    };

    for (const line of patch.split("\n")) {
        const header = HUNK_HEADER.exec(line);
        if (header !== null) {
            // A marker between regions always; before the first one only when the file starts above it. An
            // added file's before side reports start 0, which is not "line 1" and not a gap either.
            if (regions > 0 || Number(header[1]) > 1 || Number(header[2]) > 1) {
                gap();
            }
            beforeAt = Number(header[1]);
            afterAt = Number(header[2]);
            regions += 1;
            continue;
        }
        if (regions === 0) {
            continue; // anything above the first hunk: git's file headers, or a producer's preamble
        }
        // An empty line is a context line whose leading space was stripped somewhere along the way; reading it
        // as one costs nothing and rescues a patch that would otherwise stop mid-region.
        const mark = line[0] ?? " ";
        const text = line.slice(1);
        if (mark === " " || line === "") {
            before.push(text);
            beforeLines.push(beforeAt++);
            after.push(text);
            afterLines.push(afterAt++);
            continue;
        }
        if (mark === "-") {
            before.push(text);
            beforeLines.push(beforeAt++);
            continue;
        }
        if (mark === "+") {
            after.push(text);
            afterLines.push(afterAt++);
        }
        // Anything else ("\ No newline at end of file") describes the patch rather than the file: not a line.
    }

    if (regions === 0) {
        return undefined;
    }
    if (more) {
        gap();
    }
    return { before: before.join("\n"), after: after.join("\n"), beforeLines, afterLines, regions };
};
