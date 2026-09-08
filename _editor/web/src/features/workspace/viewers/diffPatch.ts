// Unified patch turned back into two sides a diff editor can hold, so a huge file reviews in the same Monaco
// diff as any other, colour/minimap/nav all free. Line numbers are the file's own via a gutter lookup, not 1..n;
// joins between regions are a visible gap marker on both sides, keeping the panes aligned.

// Stand-in for lines between regions, on both sides so the engine sees them as unchanged and aligned.
export const PATCH_GAP = "⋯";

export interface PatchedSides {
    readonly before: string;
    readonly after: string;
    // Model line → file line, 1-based, index = model line − 1; 0 is a gap marker. Handed to DiffView as its gutter.
    readonly beforeLines: readonly number[];
    readonly afterLines: readonly number[];
    // How many changed regions the patch held: what the notice above the panes counts.
    readonly regions: number;
}

// Only the two starts are read; a byte-clipped patch may hold fewer lines than its counts claim.
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Rebuilds the two sides. `more` (patch cut short) is the only case with a trailing gap, or it would falsely
// claim the file's end. Undefined (no regions) is drawn as nothing to show, not two empty panes.
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
            // Marker between regions always; before the first only if the file starts above it (an add's start is 0).
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
        // Empty line = context line with its leading space stripped; reading it as one avoids stopping mid-region.
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
