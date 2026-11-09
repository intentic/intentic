// WHICH PART OF THE RAIL FLIES WHERE when it unrolls or folds (railMorph.ts plays it): pure, from where the parts stood
// and where they stand, so the choreography is pinned without a window.

export interface Box {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/** A part of the rail that takes part: what it is, the group it belongs to if any, and where it stands. */
export interface RailMark {
    readonly key: string;
    readonly into?: string | undefined;
    readonly box: Box;
}

/** The rail as it stands in one of its two states: its parts, and what stands for each group folded away. */
export interface RailArrangement {
    readonly marks: readonly RailMark[];
    readonly holders: Readonly<Record<string, Box>>;
}

/**
 * A part that travels between the rail's two states. `move`: in both, somewhere else. `emerge`: new, out of what held its
 * group. `merge`: gone, into what holds its group now. `step` is its turn in the stagger, 0 first.
 */
export interface Travel {
    readonly kind: `move` | `emerge` | `merge`;
    readonly key: string;
    readonly from: Box;
    readonly to: Box;
    readonly step: number;
}

/** A part that is new with nowhere to come from: it appears in place, after everything that travels. */
export interface Arrival {
    readonly kind: `appear`;
    readonly key: string;
    readonly to: Box;
    readonly step: number;
}

/** One part's share of the change. */
export type Flight = Travel | Arrival;

// How small a part is inside what holds its group: it leaves and arrives as a speck of itself at the holder's middle.
const PINCH = 0.35;

const middle = (box: Box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

const pinched = (holder: Box, part: Box): Box => {
    const at = middle(holder);
    const width = part.width * PINCH;
    const height = part.height * PINCH;
    return { left: at.x - width / 2, top: at.y - height / 2, width, height };
};

const distance = (left: Box, right: Box): number => Math.hypot(middle(left).x - middle(right).x, middle(left).y - middle(right).y);

// Half a pixel: a part that did not move is not flown, and a layout read is never exact to the last digit.
const sameBox = (left: Box, right: Box): boolean =>
    Math.abs(left.left - right.left) < 0.5 &&
    Math.abs(left.top - right.top) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5;

/**
 * Every flight from the rail as it stood to the rail as it stands. A part in both moves from its old place to its new one, in the rail's own
 * order. A part only in the new one emerges from what held its group in the old one, the one with farthest to go first,
 * so the parts leave the holder already in the order they will stand in and none crosses another; with nothing that held
 * it, it appears, after everything that flies. A part only in
 * the old one merges into what holds its group in the new one, nearest first, so the list is drawn in from that end;
 * with nothing to hold it, it is simply gone. A part that stands where it stood takes no part.
 */
export const planFlights = (before: RailArrangement, after: RailArrangement): Flight[] => {
    const was = new Map(before.marks.map((mark) => [mark.key, mark]));
    const is = new Set(after.marks.map((mark) => mark.key));
    const moves: Travel[] = [];
    const emerging: { mark: RailMark; holder: Box }[] = [];
    const appearing: RailMark[] = [];
    for (const mark of after.marks) {
        const prior = was.get(mark.key);
        if (prior !== undefined) {
            if (!sameBox(prior.box, mark.box)) {
                moves.push({ kind: `move`, key: mark.key, from: prior.box, to: mark.box, step: moves.length });
            }
            continue;
        }
        const holder = mark.into === undefined ? undefined : before.holders[mark.into];
        if (holder === undefined) {
            appearing.push(mark);
        } else {
            emerging.push({ mark, holder });
        }
    }
    const merging = before.marks.flatMap((mark) => {
        const holder = is.has(mark.key) || mark.into === undefined ? undefined : after.holders[mark.into];
        return holder === undefined ? [] : [{ mark, holder }];
    });
    const nearestFirst = (left: { mark: RailMark; holder: Box }, right: { mark: RailMark; holder: Box }): number =>
        distance(left.mark.box, left.holder) - distance(right.mark.box, right.holder);
    const emerges = emerging
        .toSorted((left, right) => nearestFirst(right, left))
        .map(({ mark, holder }, step): Travel => ({ kind: `emerge`, key: mark.key, from: pinched(holder, mark.box), to: mark.box, step }));
    const merges = merging
        .toSorted(nearestFirst)
        .map(({ mark, holder }, step): Travel => ({ kind: `merge`, key: mark.key, from: mark.box, to: pinched(holder, mark.box), step }));
    const flown = Math.max(moves.length, emerges.length, merges.length);
    // Nothing flew: the rail did not change, and a part that only mounted (a tile that loaded) is no change to explain.
    const appears = flown === 0 ? [] : appearing.map((mark): Arrival => ({ kind: `appear`, key: mark.key, to: mark.box, step: flown }));
    return [...moves, ...emerges, ...merges, ...appears];
};
