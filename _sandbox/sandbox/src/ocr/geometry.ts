// The plane geometry text detection needs: the convex hull of a blob, its smallest rotated rectangle, and the
// perspective map that lays a tilted line of text flat. Written to answer as OpenCV's minAreaRect, boxPoints and
// getPerspectiveTransform do for PaddleOCR's own pipeline, so a box found here is the box PaddleOCR would draw.

export interface Point {
    readonly x: number;
    readonly y: number;
}

// Four corners in reading order: top-left, top-right, bottom-right, bottom-left.
export type Quad = readonly [Point, Point, Point, Point];

export interface RotatedRect {
    readonly center: Point;
    readonly width: number;
    readonly height: number;
    // Radians; the direction of the `width` side.
    readonly angle: number;
}

const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

// Andrew's monotone chain, counter-clockwise, no collinear points.
export const convexHull = (points: readonly Point[]): Point[] => {
    const sorted = points.toSorted((a, b) => a.x - b.x || a.y - b.y);
    if (sorted.length <= 2) {
        return sorted;
    }
    const lower: Point[] = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower.at(-2) as Point, lower.at(-1) as Point, point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }
    const upper: Point[] = [];
    for (const point of sorted.toReversed()) {
        while (upper.length >= 2 && cross(upper.at(-2) as Point, upper.at(-1) as Point, point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
};

// The rectangle of least area holding every point, by rotating calipers over the hull's edges: one side of the
// minimal rectangle always lies along an edge of the hull.
export const minAreaRect = (points: readonly Point[]): RotatedRect => {
    const hull = convexHull(points);
    if (hull.length === 0) {
        return { center: { x: 0, y: 0 }, width: 0, height: 0, angle: 0 };
    }
    if (hull.length === 1) {
        return { center: hull[0] as Point, width: 0, height: 0, angle: 0 };
    }
    let best: RotatedRect | undefined;
    let bestArea = Number.POSITIVE_INFINITY;
    for (let index = 0; index < hull.length; index += 1) {
        const a = hull[index] as Point;
        const b = hull[(index + 1) % hull.length] as Point;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length === 0) {
            continue;
        }
        const ux = (b.x - a.x) / length;
        const uy = (b.y - a.y) / length;
        let minU = Number.POSITIVE_INFINITY;
        let maxU = Number.NEGATIVE_INFINITY;
        let minV = Number.POSITIVE_INFINITY;
        let maxV = Number.NEGATIVE_INFINITY;
        for (const point of hull) {
            const u = point.x * ux + point.y * uy;
            const v = -point.x * uy + point.y * ux;
            minU = Math.min(minU, u);
            maxU = Math.max(maxU, u);
            minV = Math.min(minV, v);
            maxV = Math.max(maxV, v);
        }
        const area = (maxU - minU) * (maxV - minV);
        if (area < bestArea - 1e-9) {
            bestArea = area;
            const cu = (minU + maxU) / 2;
            const cv = (minV + maxV) / 2;
            best = {
                center: { x: cu * ux - cv * uy, y: cu * uy + cv * ux },
                width: maxU - minU,
                height: maxV - minV,
                angle: Math.atan2(uy, ux),
            };
        }
    }
    return best ?? { center: hull[0] as Point, width: 0, height: 0, angle: 0 };
};

// The same rectangle grown by `by` on every side, as offsetting its outline by that distance and taking the
// rectangle of the result (what PaddleOCR's unclip does with pyclipper) comes to.
export const grownRect = (rect: RotatedRect, by: number): RotatedRect => ({ ...rect, width: rect.width + 2 * by, height: rect.height + 2 * by });

// The rectangle's corners, ordered as PaddleOCR's get_mini_boxes orders them: the two leftmost become the left side,
// the upper of each pair first.
export const rectCorners = (rect: RotatedRect): Quad => {
    const cos = Math.cos(rect.angle);
    const sin = Math.sin(rect.angle);
    const hw = rect.width / 2;
    const hh = rect.height / 2;
    const corners = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
    ].map(([u = 0, v = 0]) => ({ x: rect.center.x + u * cos - v * sin, y: rect.center.y + u * sin + v * cos }));
    const byX = corners.toSorted((a, b) => a.x - b.x);
    const [p0, p1, p2, p3] = byX as [Point, Point, Point, Point];
    const [topLeft, bottomLeft] = p1.y > p0.y ? [p0, p1] : [p1, p0];
    const [topRight, bottomRight] = p3.y > p2.y ? [p2, p3] : [p3, p2];
    return [topLeft, topRight, bottomRight, bottomLeft];
};

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

// Rounding as Python's round() and numpy's do, half to even (2.5 is 2, 3.5 is 4): PaddleOCR sizes its input and places
// its boxes with it, and a size off by one multiple of 32 is a different picture to the model.
export const roundHalfEven = (value: number): number => {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction > 0.5) {
        return floor + 1;
    }
    if (fraction < 0.5) {
        return floor;
    }
    return floor % 2 === 0 ? floor : floor + 1;
};

// A 3x3 homography, row-major, mapping `from` onto `to` corner for corner (OpenCV's getPerspectiveTransform).
export const perspectiveTransform = (from: Quad, to: Quad): number[] => {
    // Eight unknowns h0..h7 with h8 = 1: two equations per corner.
    const rows: number[][] = [];
    for (let index = 0; index < 4; index += 1) {
        const { x, y } = from[index] as Point;
        const { x: u, y: v } = to[index] as Point;
        rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
        rows.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
    }
    // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
    for (let column = 0; column < 8; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < 8; row += 1) {
            if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) {
                pivot = row;
            }
        }
        [rows[column], rows[pivot]] = [rows[pivot] as number[], rows[column] as number[]];
        const lead = rows[column] as number[];
        const divisor = lead[column] ?? 0;
        if (Math.abs(divisor) < 1e-12) {
            throw new Error("perspectiveTransform: the corners are degenerate");
        }
        for (let row = 0; row < 8; row += 1) {
            if (row === column) {
                continue;
            }
            const target = rows[row] as number[];
            const factor = (target[column] ?? 0) / divisor;
            for (let k = column; k < 9; k += 1) {
                target[k] = (target[k] ?? 0) - factor * (lead[k] ?? 0);
            }
        }
    }
    const h = rows.map((row, index) => (row[8] ?? 0) / (row[index] ?? 1));
    return [...h, 1];
};

export const applyTransform = (h: readonly number[], x: number, y: number): Point => {
    const w = (h[6] ?? 0) * x + (h[7] ?? 0) * y + (h[8] ?? 1);
    return { x: ((h[0] ?? 0) * x + (h[1] ?? 0) * y + (h[2] ?? 0)) / w, y: ((h[3] ?? 0) * x + (h[4] ?? 0) * y + (h[5] ?? 0)) / w };
};

export const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// Every pixel (x, y) whose centre-scanline the polygon covers, row by row, as OpenCV's fillPoly fills an integer
// polygon: the visitor gets each row's inclusive span, clipped to the bounds.
export const fillPolygon = (
    polygon: readonly Point[],
    bounds: { readonly width: number; readonly height: number },
    visit: (y: number, fromX: number, toX: number) => void,
): void => {
    if (polygon.length < 3) {
        return;
    }
    const ys = polygon.map((point) => point.y);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(bounds.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y += 1) {
        const crossings: number[] = [];
        for (let index = 0; index < polygon.length; index += 1) {
            const a = polygon[index] as Point;
            const b = polygon[(index + 1) % polygon.length] as Point;
            if (a.y === b.y) {
                continue;
            }
            const [low, high] = a.y < b.y ? [a, b] : [b, a];
            // Half-open in y, so a vertex shared by two edges is counted once.
            if (y >= low.y && y < high.y) {
                crossings.push(low.x + ((y - low.y) * (high.x - low.x)) / (high.y - low.y));
            }
        }
        // A horizontal top or bottom edge still fills its own row.
        if (crossings.length === 0) {
            const onRow = polygon.filter((point) => Math.round(point.y) === y).map((point) => point.x);
            if (onRow.length >= 2) {
                crossings.push(Math.min(...onRow), Math.max(...onRow));
            }
        }
        crossings.sort((left, right) => left - right);
        for (let index = 0; index + 1 < crossings.length; index += 2) {
            const fromX = Math.max(0, Math.ceil((crossings[index] ?? 0) - 1e-9));
            const toX = Math.min(bounds.width - 1, Math.floor((crossings[index + 1] ?? 0) + 1e-9));
            if (toX >= fromX) {
                visit(y, fromX, toX);
            }
        }
    }
};
