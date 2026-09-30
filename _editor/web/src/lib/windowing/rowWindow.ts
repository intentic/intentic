// How tall a list is, and which slice of it crosses a viewport. Index arithmetic over row heights, so a window into
// fifty thousand rows costs what a window into fifty does. Pure, no DOM: the view hands in a scroll offset and a height.

export interface RowMetrics {
    readonly count: number;
    // The list's full height, which the spacer gives the scroller so its range matches the untruncated list.
    readonly total: number;
    // Top edge of row `index`; defined at `count` too, where it is `total`, so a half-open range has an end offset.
    readonly offsetOf: (index: number) => number;
    // The row `y` falls in, clamped into range. `0` for an empty list, so callers never get -1 to guard.
    readonly indexAt: (y: number) => number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// Rows that are all the same height: no per-row storage, and every answer is one division.
export const uniformRows = (count: number, height: number): RowMetrics => {
    // A zero height would put every row at offset 0 and make indexAt divide by zero; one pixel keeps both monotonic.
    const step = Math.max(1, height);
    return {
        count,
        total: count * step,
        offsetOf: (index) => clamp(index, 0, count) * step,
        indexAt: (y) => clamp(Math.floor(y / step), 0, Math.max(0, count - 1)),
    };
};

/**
 * Rows of differing heights, prefix-summed once on construction so `indexAt` is a binary search rather than a scan.
 *
 * Build this from a stable list (a computed over the row model), not per scroll event: the summing is O(n).
 */
export const variableRows = (heights: readonly number[]): RowMetrics => {
    // One longer than the list: `offsets[i]` is row i's top, and the last entry is the total.
    const offsets = new Float64Array(heights.length + 1);
    for (const [index, height] of heights.entries()) {
        offsets[index + 1] = offsets[index]! + Math.max(0, height);
    }
    const count = heights.length;
    const total = offsets[count]!;
    return {
        count,
        total,
        offsetOf: (index) => offsets[clamp(index, 0, count)]!,
        indexAt: (y) => {
            if (count === 0) {
                return 0;
            }
            // Rightmost row whose top is at or before `y`. Zero-height rows share a top; the last of them wins, which
            // is the one a reader would say they are looking at.
            let low = 0;
            let high = count - 1;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                if (offsets[mid]! <= y) {
                    low = mid;
                } else {
                    high = mid - 1;
                }
            }
            return low;
        },
    };
};

// The half-open slice of rows worth having in the DOM, widened by `overscan` rows each side so a fast scroll paints
// something rather than blank. Clamped to the list, so `first <= last` always.
export const windowOf = (
    metrics: RowMetrics,
    scrollTop: number,
    viewport: number,
    overscan: number,
): { readonly first: number; readonly last: number } => {
    if (metrics.count === 0) {
        return { first: 0, last: 0 };
    }
    const top = Math.max(0, scrollTop);
    const first = Math.max(0, metrics.indexAt(top) - overscan);
    const last = Math.min(metrics.count, metrics.indexAt(top + Math.max(0, viewport)) + 1 + overscan);
    return { first, last };
};

/**
 * Where the scroller must sit for row `index` to be fully visible, moving as little as possible: unchanged when the row
 * already fits, else scrolled just far enough to bring its near edge in.
 */
export const scrollToShow = (metrics: RowMetrics, index: number, scrollTop: number, viewport: number): number => {
    const top = metrics.offsetOf(index);
    const bottom = metrics.offsetOf(index + 1);
    if (top < scrollTop) {
        return top;
    }
    if (bottom > scrollTop + viewport) {
        // Never past the row's own top: a row taller than the viewport shows its start, not its end.
        return Math.min(top, bottom - viewport);
    }
    return scrollTop;
};
