// What an update to a script changes, line by line, for the person reviewing it in the popup: a shortest edit script
// between the two versions' lines, the kept lines plain and the rest marked added or removed. Plain, since the popup
// bundles no library; past a bound of work two versions read as too different to compare here, and the new code is
// shown whole.

export interface DiffLine {
    readonly kind: "same" | "added" | "removed";
    readonly text: string;
}

// The most work a diff may take, in table cells: the old full table's size limit, and its time.
const MAX_CELLS = 4_000_000;
// One search step costs about this many table cells (2026-11-24, Node 24).
const STEP_CELLS = 4;
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

// The diagonals of step d's parity that hold any point of an n-by-m grid.
const diagonalsAt = (d: number, n: number, m: number): readonly [number, number] => [
    Math.max(-d, (m + d) % 2 === 0 ? -m : 1 - m),
    Math.min(d, (n + d) % 2 === 0 ? n : n - 1),
];

// Where step d starts on diagonal k: one past the left neighbour's point (a removal) or the right one's (an
// addition), whichever lies further and stays inside the grid; -1 when neither does.
const entryAt = (v: Int32Array, shift: number, d: number, k: number, n: number, m: number): number => {
    if (d === 0) {
        return 0;
    }
    const left = v[k - 1 + shift]!;
    const removal = left >= 0 && left < n ? left + 1 : -1;
    const right = v[k + 1 + shift]!;
    return right > removal && right - k <= m ? right : removal;
};

interface Reach {
    readonly distance: number;
    readonly within: (d: number, i: number, j: number) => boolean;
}

// Whether line (i, j) of the two versions is within d edits of their ends, and how many edits the whole takes; by
// Myers' greedy search run from the ends back to `from`, keeping for every d the furthest point back on each diagonal
// (x - y, both counted from the end) that is within d. Undefined once it has done `budget` steps.
const reachFromEnd = (before: readonly string[], after: readonly string[], from: number, budget: number): Reach | undefined => {
    const n = before.length - from;
    const m = after.length - from;
    // The furthest x on each diagonal so far (index k + m + 1), -1 for none yet.
    const v = new Int32Array(n + m + 3).fill(-1);
    const shift = m + 1;
    // Each step's row, for the walk: its first diagonal, where its values begin in `rows`.
    const lows: number[] = [];
    const starts: number[] = [];
    const rows: number[] = [];
    const slide = (start: number, k: number): number => {
        let x = start;
        while (x < n && x - k < m && before[before.length - 1 - x] === after[after.length - 1 - x + k]) {
            x++;
        }
        return x;
    };
    const at = (step: number, k: number): number => {
        const first = lows[step];
        const index = first === undefined || k < first || ((k - first) & 1) === 1 ? -1 : starts[step]! + ((k - first) >> 1);
        return index >= 0 && index < (starts[step + 1] ?? rows.length) ? rows[index]! : -1;
    };
    let work = 0;
    for (let d = 0; ; d++) {
        const [low, high] = diagonalsAt(d, n, m);
        lows.push(low);
        starts.push(rows.length);
        for (let k = low; k <= high; k += 2) {
            const entry = entryAt(v, shift, d, k, n, m);
            const x = entry < 0 ? entry : slide(entry, k);
            work += Math.max(0, x - entry) + 1;
            v[k + shift] = Math.max(x, v[k + shift]!);
            rows.push(v[k + shift]!);
            if (k === n - m && v[k + shift]! >= n) {
                return { distance: d, within: (step, i, j) => at(step, before.length - i - (after.length - j)) >= before.length - i };
            }
            if (work > budget) {
                return undefined;
            }
        }
    }
};

// Every line of both versions in order, or undefined when they are too different to compare here.
//
// 2026-11-24: replaced a full longest-common-subsequence table, which gave up past 4M cells, so any script over about
// 2,000 lines read as "shown whole" however small the update. Now the work grows with how much changed: a 2,000-line
// script with 10 edits diffs in 0.3 ms and a 20,000-line one in 3 ms (both given up before); 1,000 lines with 10 edits
// went from 3.5 to 0.2 ms. Versions with little in common still use the table while it fits (a 1,000-line rewrite
// 3.8 → 5.6 ms) and give up past it, now after about 35 ms of looking rather than at once. Same lines, in the same order, as the table
// on every pair it answered: additions before removals where either keeps the script shortest.
export const lineDiff = (beforeText: string, afterText: string): DiffLine[] | undefined => {
    const before = beforeText.split("\n");
    const after = afterText.split("\n");
    let from = 0;
    while (from < before.length && from < after.length && before[from] === after[from]) {
        from++;
    }
    const n = before.length - from;
    const m = after.length - from;
    const fits = (before.length + 1) * (after.length + 1) <= MAX_CELLS;
    const reach = reachFromEnd(before, after, from, (fits ? (n * m) / 4 : MAX_CELLS) / STEP_CELLS + n + m);
    if (reach === undefined && !fits) {
        return undefined;
    }
    // Remaining edits from (i, j): from the search, else from the table (lengths of the common subsequence left).
    const lengths = reach === undefined ? table(before, after) : undefined;
    const width = after.length + 1;
    let left = reach?.distance ?? 0;
    const addFirst = (i: number, j: number): boolean =>
        reach === undefined ? lengths![i * width + j + 1]! >= lengths![(i + 1) * width + j]! : reach.within(left - 1, i, j + 1);
    const lines: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < before.length || j < after.length) {
        if (i < before.length && j < after.length && before[i] === after[j]) {
            lines.push({ kind: "same", text: before[i]! });
            i++;
            j++;
        } else if (j < after.length && (i === before.length || addFirst(i, j))) {
            lines.push({ kind: "added", text: after[j]! });
            j++;
            left--;
        } else {
            lines.push({ kind: "removed", text: before[i]! });
            i++;
            left--;
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
