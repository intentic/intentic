// Pinch-zooming the picture is a local magnifier: the point under the fingers stays under them, the view never shows
// past the picture's edge, and a pan at the edge hands back what it could not move.
import { restingBox, viewZoom, zoomStyle, type ZoomState } from "./viewZoom";

const box = { left: 0, top: 0, width: 400, height: 300 };

const zoomed = () => {
    const states: ZoomState[] = [];
    const zoom = viewZoom((state) => states.push(state));
    return { zoom, states };
};

test("spreading the fingers to twice their gap doubles the view about the point between them", () => {
    const { zoom } = zoomed();
    zoom.begin(200, 150, 20, box);
    zoom.pinch(200, 150, 40);
    expect(zoom.state()).toEqual({ scale: 2, x: -200, y: -150 });
    expect(zoomStyle(zoom.state())).toEqual({ transform: `translate(-200px, -150px) scale(2)`, transformOrigin: `0 0` });
});

test("the view is kept covering the picture: a pinch at a corner cannot pull its edge inward", () => {
    const { zoom } = zoomed();
    zoom.begin(10, 10, 20, box);
    zoom.pinch(40, 40, 60);
    expect(zoom.state()).toEqual({ scale: 3, x: 0, y: 0 });
});

test("pinched back to its size or smaller, the view is at rest and draws no transform", () => {
    const { zoom } = zoomed();
    zoom.begin(200, 150, 40, box);
    zoom.pinch(200, 150, 80);
    zoom.begin(200, 150, 80, restingBox({ left: -200, top: -150, width: 800, height: 600 }, zoom.state()));
    zoom.pinch(200, 150, 10);
    expect(zoom.state()).toEqual({ scale: 1, x: 0, y: 0 });
    expect(zoomStyle(zoom.state())).toBeUndefined();
});

test("a pan moves a zoomed view and answers what the edge stopped", () => {
    const { zoom } = zoomed();
    zoom.begin(200, 150, 20, box);
    zoom.pinch(200, 150, 40);
    expect(zoom.pan(50, 0)).toEqual([0, 0]);
    // At x = -150 the view can move 150 more before its left edge shows.
    expect(zoom.pan(200, 0)).toEqual([50, 0]);
    expect(zoom.state().x).toBe(0);
});

test("at rest a pan is all left over, for the page to scroll", () => {
    const { zoom, states } = zoomed();
    expect(zoom.pan(5, -7)).toEqual([5, -7]);
    expect(states).toEqual([]);
});

test("the resting box is read back out of a transformed one", () => {
    expect(restingBox({ left: -200, top: -150, width: 800, height: 600 }, { scale: 2, x: -200, y: -150 })).toEqual(box);
});
