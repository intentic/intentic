import { type Box, planFlights, type RailArrangement } from "./railFlights";

/* Which part of the rail flies where when it unrolls onto every sandbox or folds back onto one: the same thing in both
   moves, a section with no place of its own goes into the bookmark and comes back out of it, and nothing that stood
   still is touched. Boxes are a 40px rail's: the switcher at the top, the cluster under it, tiles down the middle, the
   bookmark at the foot. */

const tile = (top: number): Box => ({ left: 8, top, width: 40, height: 40 });
const circle = (left: number, top: number): Box => ({ left, top, width: 16, height: 16 });

const FOLDED: RailArrangement = {
    marks: [
        { key: `sandbox:shop`, box: tile(8) },
        { key: `sandbox:research`, into: `sandboxes`, box: circle(12, 56) },
        { key: `section:agents`, into: `sections`, box: tile(100) },
        { key: `section:workspace`, into: `sections`, box: tile(148) },
        { key: `process:sync`, box: tile(400) },
    ],
    holders: { sandboxes: { left: 8, top: 52, width: 40, height: 28 } },
};
const UNROLLED: RailArrangement = {
    marks: [
        { key: `sandbox:shop`, into: `sandboxes`, box: tile(8) },
        { key: `sandbox:research`, into: `sandboxes`, box: tile(56) },
        { key: `sandbox:personal`, into: `sandboxes`, box: tile(104) },
        { key: `rail:add-sandbox`, box: tile(152) },
        { key: `process:sync`, box: tile(400) },
        { key: `rail:sections`, box: tile(700) },
    ],
    holders: { sections: tile(700) },
};

const of = (flights: ReturnType<typeof planFlights>, key: string) => flights.find((flight) => flight.key === key);

describe(`unrolling onto every sandbox`, () => {
    const flights = planFlights(FOLDED, UNROLLED);

    it(`flies a sandbox from its circle in the cluster to its own tile`, () => {
        expect(of(flights, `sandbox:research`)).toMatchObject({ kind: `move`, from: circle(12, 56), to: tile(56) });
    });

    it(`leaves alone what stands where it stood: the sandbox on screen under the switcher, a process`, () => {
        expect(of(flights, `sandbox:shop`)).toBeUndefined();
        expect(of(flights, `process:sync`)).toBeUndefined();
    });

    it(`brings a sandbox the cluster had no circle for out of the cluster`, () => {
        const flight = of(flights, `sandbox:personal`);

        expect(flight).toMatchObject({ kind: `emerge`, to: tile(104) });
        // A speck of itself at the cluster's middle.
        expect(flight).toMatchObject({ from: { left: 21, top: 59, width: 14, height: 14 } });
    });

    it(`draws every section into the bookmark, the nearest to it first`, () => {
        const agents = of(flights, `section:agents`);
        const workspace = of(flights, `section:workspace`);

        expect(agents).toMatchObject({ kind: `merge`, from: tile(100), to: { left: 21, top: 713, width: 14, height: 14 } });
        expect(workspace).toMatchObject({ kind: `merge`, step: 0 });
        expect(agents).toMatchObject({ step: 1 });
    });

    it(`lets what has nowhere to come from appear after everything that flies`, () => {
        expect(of(flights, `rail:add-sandbox`)).toMatchObject({ kind: `appear`, step: 2 });
        expect(of(flights, `rail:sections`)).toMatchObject({ kind: `appear` });
    });
});

describe(`folding back onto one sandbox`, () => {
    const flights = planFlights(UNROLLED, FOLDED);

    it(`flies a sandbox from its tile back to its circle`, () => {
        expect(of(flights, `sandbox:research`)).toMatchObject({ kind: `move`, from: tile(56), to: circle(12, 56) });
    });

    it(`draws a sandbox with no circle of its own into the cluster`, () => {
        expect(of(flights, `sandbox:personal`)).toMatchObject({ kind: `merge`, from: tile(104) });
    });

    it(`brings the sections out of the bookmark, the one with farthest to go first, so none crosses another`, () => {
        expect(of(flights, `section:agents`)).toMatchObject({ kind: `emerge`, to: tile(100), step: 0 });
        expect(of(flights, `section:workspace`)).toMatchObject({ kind: `emerge`, to: tile(148), step: 1 });
    });

    it(`lets what nothing holds any more simply go`, () => {
        expect(of(flights, `rail:add-sandbox`)).toBeUndefined();
        expect(of(flights, `rail:sections`)).toBeUndefined();
    });
});

describe(`a rail that did not change`, () => {
    it(`flies nothing, and explains no part that only mounted`, () => {
        const more: RailArrangement = { ...FOLDED, marks: [...FOLDED.marks, { key: `section:late`, box: tile(196) }] };

        expect(planFlights(FOLDED, FOLDED)).toEqual([]);
        expect(planFlights(FOLDED, more)).toEqual([]);
    });
});
