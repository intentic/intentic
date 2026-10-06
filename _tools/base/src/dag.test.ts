import { dagLayers } from "./dag.js";

interface Step {
    readonly id: string;
    readonly needs: readonly string[];
}
const step = (id: string, ...needs: string[]): Step => ({ id, needs });
const layersOf = (steps: readonly Step[]): string[][] =>
    dagLayers(
        steps,
        (each) => each.id,
        (each) => each.needs,
    ).map((layer) => layer.map((each) => each.id));

test("a graph is layered by generation, each layer in input order", () => {
    // d needs a and c: c is two deep, so d is three deep, the longest chain under it, not the shortest.
    expect(layersOf([step(`d`, `a`, `c`), step(`a`), step(`c`, `b`), step(`b`, `a`), step(`e`)])).toEqual([[`a`, `e`], [`b`], [`c`], [`d`]]);
});

test("a need naming nothing, or the step itself, is not waited on", () => {
    expect(layersOf([step(`a`, `ghost`), step(`b`, `b`, `a`)])).toEqual([[`a`], [`b`]]);
});

test("a cycle and everything downstream of it land in one final layer instead of hanging", () => {
    expect(layersOf([step(`root`), step(`x`, `y`, `root`), step(`y`, `x`), step(`after`, `x`)])).toEqual([[`root`], [`x`, `y`, `after`]]);
});

test("items sharing an id are all waited for by a need on it", () => {
    // Two legs of one matrix job named `test`, the second needing `build`: `ship` waits for both legs.
    expect(layersOf([step(`build`), step(`test`), step(`test`, `build`), step(`ship`, `test`)])).toEqual([[`build`, `test`], [`test`], [`ship`]]);
});

test("nothing in, nothing out", () => {
    expect(layersOf([])).toEqual([]);
});
