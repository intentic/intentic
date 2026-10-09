// READINGS OVER EVERY ROW, PAID FOR ONLY BY THE ROWS THAT CHANGED. A streamed frame replaces the row it writes and keeps
// every other row the same object (transcriptState.ts), so the rows before the first one that changed hold exactly what
// they held a frame ago, and so does whatever a reading took from them. Each reader below remembers the rows it last
// read and what it found there, and reads only from the first changed row on. Measured at 4,000 rows on a desktop CPU,
// a frame's eight whole-transcript scans (the usage totals, the call count, the pending card, the plan, the newest
// permission) cost 0.3ms, on every frame of a streamed turn.
//
// A reader is stateful, and is correct whatever it is handed: a row object is its content, so rows it never saw are simply
// read. Handed another transcript, it reads all of it once; it saves work only for a transcript read frame after frame.

// The index of the first row that is not the same object in both, or the shorter length.
export const firstChange = <Row>(before: readonly Row[], after: readonly Row[]): number => {
    const shared = Math.min(before.length, after.length);
    let index = 0;
    while (index < shared && before[index] === after[index]) {
        index += 1;
    }
    return index;
};

// The sum of one number per row.
export const runningTotal = <Row>(value: (row: Row) => number): ((rows: readonly Row[]) => number) => {
    let seen: readonly Row[] = [];
    // `sums[index]` is the total through `seen[index]`.
    const sums: number[] = [];
    return (rows) => {
        const from = firstChange(seen, rows);
        sums.length = from;
        let sum = from === 0 ? 0 : sums[from - 1]!;
        for (let index = from; index < rows.length; index += 1) {
            sum += value(rows[index]!);
            sums.push(sum);
        }
        seen = rows;
        return sum;
    };
};

// The oldest row a test holds for.
export const firstWhere = <Row>(test: (row: Row) => boolean): ((rows: readonly Row[]) => Row | undefined) => {
    let seen: readonly Row[] = [];
    // Where the oldest match stood in `seen`; -1 for none anywhere in it.
    let at = -1;
    return (rows) => {
        const from = firstChange(seen, rows);
        seen = rows;
        if (at >= 0 && at < from) {
            return rows[at];
        }
        // None stood before `from`: either none at all, or the oldest was among the rows that changed.
        at = -1;
        for (let index = from; index < rows.length; index += 1) {
            if (test(rows[index]!)) {
                at = index;
                return rows[index];
            }
        }
        return undefined;
    };
};

// What the newest row it finds anything in says, `pick` answering undefined for a row that says nothing.
export const newestOf = <Row, Found>(pick: (row: Row) => Found | undefined): ((rows: readonly Row[]) => Found | undefined) => {
    let seen: readonly Row[] = [];
    // Where the newest find stood in `seen`, and what it was; -1 for none anywhere in it.
    let at = -1;
    let found: Found | undefined;
    const scan = (rows: readonly Row[], from: number, to: number): Found | undefined => {
        for (let index = to - 1; index >= from; index -= 1) {
            const value = pick(rows[index]!);
            if (value !== undefined) {
                at = index;
                found = value;
                return value;
            }
        }
        return undefined;
    };
    return (rows) => {
        const from = firstChange(seen, rows);
        const previous = at;
        seen = rows;
        const fresh = scan(rows, from, rows.length);
        if (fresh !== undefined) {
            return fresh;
        }
        // Nothing among the rows that changed. A find that stood before them still stands; none anywhere means none
        // before them either; one that stood among them leaves the unchanged rows to be read after all.
        if (previous >= 0 && previous < from) {
            at = previous;
            return found;
        }
        at = -1;
        found = undefined;
        return previous < 0 ? undefined : scan(rows, 0, from);
    };
};
