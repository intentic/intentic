import { applyTransform, convexHull, fillPolygon, minAreaRect, perspectiveTransform, type Quad, rectCorners, roundHalfEven } from "./geometry.js";

// The plane geometry text detection stands on, pinned to what OpenCV and Python answer for the same input, since a box
// that differs by a pixel is a different crop for the recognizer.

const square: Quad = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 3 },
    { x: 0, y: 3 },
];

test("the hull drops the points inside it", () => {
    expect(convexHull([...square, { x: 1, y: 1 }, { x: 2, y: 1 }])).toEqual([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 3 },
        { x: 0, y: 3 },
    ]);
});

test("an upright rectangle is its own smallest rectangle, its corners read from the top left", () => {
    const rect = minAreaRect([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }, { x: 5, y: 2 }]);
    expect(rect).toEqual({ center: { x: 5, y: 2 }, width: 10, height: 4, angle: 0 });
    expect(rectCorners(rect)).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 4 },
        { x: 0, y: 4 },
    ]);
});

test("a tilted rectangle is found at its own size, not its upright bounds", () => {
    const angle = Math.PI / 6;
    const points = [
        [0, 0],
        [20, 0],
        [20, 6],
        [0, 6],
        [10, 3],
    ].map(([u = 0, v = 0]) => ({ x: 50 + u * Math.cos(angle) - v * Math.sin(angle), y: 50 + u * Math.sin(angle) + v * Math.cos(angle) }));
    const rect = minAreaRect(points);
    expect([Math.round(Math.min(rect.width, rect.height)), Math.round(Math.max(rect.width, rect.height))]).toEqual([6, 20]);
});

test("a perspective map takes each corner to its counterpart", () => {
    const target: Quad = [
        { x: 10, y: 20 },
        { x: 110, y: 25 },
        { x: 105, y: 65 },
        { x: 12, y: 60 },
    ];
    const map = perspectiveTransform(square, target);
    const mapped = square.map((corner) => applyTransform(map, corner.x, corner.y)).map(({ x, y }) => ({ x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6 }));
    expect(mapped).toEqual([...target]);
});

test("a polygon fills every pixel its outline encloses, the outline included, as fillPoly does", () => {
    const rows: [number, number, number][] = [];
    fillPolygon(square, { width: 10, height: 10 }, (y, from, to) => rows.push([y, from, to]));
    expect(rows).toEqual([
        [0, 0, 3],
        [1, 0, 3],
        [2, 0, 3],
        [3, 0, 3],
    ]);
    const clipped: [number, number, number][] = [];
    fillPolygon(square, { width: 2, height: 2 }, (y, from, to) => clipped.push([y, from, to]));
    expect(clipped).toEqual([
        [0, 0, 1],
        [1, 0, 1],
    ]);
});

test("halves round to even, as Python rounds", () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4, 2.6, 31.5].map(roundHalfEven)).toEqual([0, 2, 2, 4, 2, 3, 32]);
});
