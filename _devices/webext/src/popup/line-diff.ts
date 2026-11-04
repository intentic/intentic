// What an update to a script changes, line by line, for the person reviewing it in the popup: the longest common
// subsequence of the two versions' lines, then the rest marked added or removed. Plain, since the popup bundles no
// library; past MAX_CELLS the table would be too big to build at once in a click, and the new code is shown whole.

export interface DiffLine {
    readonly kind: "same" | "added" | "removed";
    readonly text: string;
}

const MAX_CELLS = 4_000_000;
// Unchanged lines kept around each change, the rest folded into one "…" line.
const CONTEXT = 3;

const table = (before: readonly string[], after: readonly string[]): Uint32Array => {
    const width = after.length + 1;
    const lengths = new Uint32Array((before.length + 1) * width);
    for (let i = before.length - 1; i >= 0; i--) {
        for (let j = after.length - 1; j >= 0; j--) {
            lengths[i * width + j] =
                before[i] === after[j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
        }
    }
    return lengths;
};

// Every line of both versions in order, or undefined when they are too long to compare here.
export const lineDiff = (beforeText: string, afterText: string): DiffLine[] | undefined => {
    const before = beforeText.split("\n");
    const after = afterText.split("\n");
    if ((before.length + 1) * (after.length + 1) > MAX_CELLS) {
        return undefined;
    }
    const lengths = table(before, after);
    const width = after.length + 1;
    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < before.length || j < after.length) {
        if (i < before.length && j < after.length && before[i] === after[j]) {
            lines.push({ kind: "same", text: before[i]! });
            i++;
            j++;
        } else if (j < after.length && (i === before.length || lengths[i * width + j + 1]! >= lengths[(i + 1) * width + j]!)) {
            lines.push({ kind: "added", text: after[j]! });
            j++;
        } else {
            lines.push({ kind: "removed", text: before[i]! });
            i++;
        }
    }
    return lines;
};

// The changed lines with a little of what surrounds them; a run of unchanged lines between becomes one "…".
export const aroundChanges = (lines: readonly DiffLine[]): (DiffLine | "fold")[] => {
    const near = lines.map((line, index) =>
        lines.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((each) => each.kind !== "same") || line.kind !== "same",
    );
    const shown: (DiffLine | "fold")[] = [];
    lines.forEach((line, index) => {
        if (near[index] === true) {
            shown.push(line);
        } else if (shown.at(-1) !== "fold") {
            shown.push("fold");
        }
    });
    return shown;
};
