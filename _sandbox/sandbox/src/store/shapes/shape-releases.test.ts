import { beforeHorizon, freeze, type Release, type Shapes, UNRELEASED } from "./shape-releases.js";

// Which release first shipped each frozen shape, and which never shipped at all: the record the vanished-key and fit
// checks are generated from, so a shape kept that never shipped costs only a check, and one dropped that did ship
// strands a file.

const KEY = "workspace:.intentic/config/settings.json";
const at = (records: Record<string, Shapes>) => (tag: string): Shapes | undefined => records[tag];

test("a new shape is recorded unreleased, and a later one before any release replaces it", () => {
    const first = freeze({}, new Map([[KEY, "{ a: string }"]]), [], at({}));
    expect(first).toEqual({ [KEY]: [{ type: "{ a: string }", since: UNRELEASED }] });
    const second = freeze(first, new Map([[KEY, "{ a?: string }"]]), [], at({}));
    expect(second).toEqual({ [KEY]: [{ type: "{ a?: string }", since: UNRELEASED }] });
});

test("an unreleased shape a release holds as its last is stamped with that release; one it held only on the way is dropped", () => {
    const shapes: Shapes = {
        [KEY]: [
            { type: "A", since: "v1.300.0" },
            { type: "B", since: UNRELEASED },
            { type: "C", since: UNRELEASED },
        ],
    };
    const releases: Release[] = [{ tag: "v1.301.0", day: "2026-09-26" }];
    const record = { "v1.301.0": { [KEY]: [{ type: "A", since: "v1.300.0" }, { type: "B", since: UNRELEASED }, { type: "C", since: UNRELEASED }] } };
    expect(freeze(shapes, new Map([[KEY, "C"]]), releases, at(record))).toEqual({
        [KEY]: [
            { type: "A", since: "v1.300.0" },
            { type: "C", since: "v1.301.0" },
        ],
    });
});

test("a shape frozen after the newest release stays unreleased, and today's shape already on record adds nothing", () => {
    const shapes: Shapes = { [KEY]: [{ type: "A", since: "v1.300.0" }, { type: "B", since: UNRELEASED }] };
    const record = { "v1.300.0": { [KEY]: [{ type: "A", since: "v1.300.0" }] } };
    expect(freeze(shapes, new Map([[KEY, "B"]]), [{ tag: "v1.300.0", day: "2026-09-20" }], at(record))).toEqual(shapes);
});

test("a day-dated shape a release cut that day or later may have shipped, before the record existed, is kept with that release", () => {
    const shapes: Shapes = {
        [KEY]: [
            { type: "A", since: "2026-09-24" },
            { type: "B", since: "2026-09-24" },
            { type: "C", since: "2026-09-25" },
            { type: "D", since: "2026-09-25" },
        ],
    };
    const releases: Release[] = [
        { tag: "v1.310.0", day: "2026-09-23" },
        { tag: "v1.311.0", day: "2026-09-24" },
        { tag: "v1.312.0", day: "2026-09-25" },
    ];
    // v1.311.0 predates the record; v1.312.0 holds all four, D last.
    const record = { "v1.312.0": { [KEY]: [...(shapes[KEY] ?? [])] } };
    expect(freeze(shapes, new Map([[KEY, "D"]]), releases, at(record))).toEqual({
        [KEY]: [
            // Possibly written by v1.311.0, cut the same day: kept.
            { type: "A", since: "v1.311.0" },
            { type: "B", since: "v1.311.0" },
            // Dated after v1.311.0 and only an intermediate of v1.312.0: never shipped.
            { type: "D", since: "v1.312.0" },
        ],
    });
});

test("a shape is past the horizon only once the shape after it had shipped by then", () => {
    const next = (since: string) => ({ type: "B", since });
    expect(beforeHorizon(next("v1.232.0"), "v1.232.0")).toBe(true);
    expect(beforeHorizon(next("v1.233.0"), "v1.232.0")).toBe(false);
    // Still current, or its successor not yet released: every file from the horizon on may hold it.
    expect(beforeHorizon(undefined, "v1.232.0")).toBe(false);
    expect(beforeHorizon(next(UNRELEASED), "v1.232.0")).toBe(false);
    expect(beforeHorizon(next("v1.200.0"), undefined)).toBe(false);
});
