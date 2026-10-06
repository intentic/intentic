import { inFlightMarks } from "./in-flight.js";
import { holdIcFlow, icInFlight, icSwapsInFlight } from "../tools/sandboxes.js";

test("two overlapping holds on one slug keep it marked until the last one is released", () => {
    const marks = inFlightMarks();
    const update = marks.hold("web");
    const round = marks.hold("web");

    update();
    expect([...marks.slugs]).toStrictEqual(["web"]);

    round();
    expect([...marks.slugs]).toStrictEqual([]);
});

test("a release called twice counts once, so it never unmarks a slug another flow still holds", () => {
    const marks = inFlightMarks();
    const first = marks.hold("web");
    const second = marks.hold("web");

    first();
    first();
    expect([...marks.slugs]).toStrictEqual(["web"]);

    second();
    expect([...marks.slugs]).toStrictEqual([]);
    // Nothing went negative: one fresh hold marks the slug again, and its one release clears it.
    const again = marks.hold("web");
    expect([...marks.slugs]).toStrictEqual(["web"]);
    again();
    second();
    expect([...marks.slugs]).toStrictEqual([]);
});

test("holds on different slugs are counted apart", () => {
    const marks = inFlightMarks();
    const web = marks.hold("web");
    const api = marks.hold("api");

    web();
    expect([...marks.slugs]).toStrictEqual(["api"]);
    api();
    expect([...marks.slugs]).toStrictEqual([]);
});

// A person's update (moves a container) overlapping a background prepare on one sandbox: the prepare ending first must
// not tell the rounds or the agent's restart that nothing is in flight there.
test("an ic flow that moves a container keeps its slug mid-swap past an overlapping flow that ends first", () => {
    const update = holdIcFlow("overlap-web", { moves: true });
    const prepare = holdIcFlow("overlap-web", { moves: false });

    prepare();
    expect({ flowing: icInFlight.has("overlap-web"), swapping: icSwapsInFlight.has("overlap-web") }).toStrictEqual({ flowing: true, swapping: true });

    update();
    expect({ flowing: icInFlight.has("overlap-web"), swapping: icSwapsInFlight.has("overlap-web") }).toStrictEqual({ flowing: false, swapping: false });
});

test("a prepare outliving the update it overlapped keeps the slug in flight, but no longer mid-swap", () => {
    const update = holdIcFlow("overlap-api", { moves: true });
    const prepare = holdIcFlow("overlap-api", { moves: false });

    update();
    expect({ flowing: icInFlight.has("overlap-api"), swapping: icSwapsInFlight.has("overlap-api") }).toStrictEqual({ flowing: true, swapping: false });

    prepare();
    expect({ flowing: icInFlight.has("overlap-api"), swapping: icSwapsInFlight.has("overlap-api") }).toStrictEqual({ flowing: false, swapping: false });
});
