import { curve, elbow, entryOf, exitOf, portsAlong } from "./mapGeometry";

const card = { left: 10, top: 20, right: 110, bottom: 60 };

describe(`anchors`, () => {
    it(`leaves from the trailing edge and arrives at the leading one, along the flow`, () => {
        expect(exitOf(card, `across`)).toEqual({ x: 110, y: 40 });
        expect(entryOf(card, `across`)).toEqual({ x: 10, y: 40 });
        expect(exitOf(card, `down`)).toEqual({ x: 60, y: 60 });
        expect(entryOf(card, `down`)).toEqual({ x: 60, y: 20 });
    });
});

describe(`curve`, () => {
    // Both handles level with their ends: a fan of curves leaving one door reads as one bundle.
    it(`keeps both ends level with the flow`, () => {
        expect(curve({ x: 0, y: 0 }, { x: 100, y: 50 }, `across`)).toBe(`M0 0 C50 0 50 50 100 50`);
        expect(curve({ x: 0, y: 0 }, { x: 40, y: 100 }, `down`)).toBe(`M0 0 C0 50 40 50 40 100`);
    });

    it(`bends a short gap rather than kinking it`, () => {
        expect(curve({ x: 0, y: 0 }, { x: 10, y: 30 }, `across`)).toBe(`M0 0 C24 0 -14 30 10 30`);
    });
});

describe(`portsAlong`, () => {
    it(`puts each port level with its cluster where the edge allows`, () => {
        expect(portsAlong([50, 120], 0, 200, 20)).toEqual([50, 120]);
    });

    it(`keeps ports apart, and slides a run that overflows the far end back as one`, () => {
        expect(portsAlong([100, 100, 100], 0, 200, 20)).toEqual([100, 120, 140]);
        expect(portsAlong([190, 300, 400], 0, 200, 20)).toEqual([140, 160, 180]);
    });

    it(`holds a cluster above the box at its near end`, () => {
        expect(portsAlong([-50], 0, 200, 20)).toEqual([20]);
    });
});

describe(`elbow`, () => {
    // Every line bound for one side shares the spine: the turns sit on it, so lines merge there instead of crossing.
    it(`turns onto the spine and off it with rounded corners`, () => {
        expect(elbow({ x: 0, y: 0 }, { x: 100, y: 80 }, 50)).toBe(`M0 0 H40 Q50 0 50 10 V70 Q50 80 60 80 H100`);
        expect(elbow({ x: 100, y: 80 }, { x: 0, y: 0 }, 50)).toBe(`M100 80 H60 Q50 80 50 70 V10 Q50 0 40 0 H0`);
    });

    it(`runs straight when the two ends are level, and tightens its corners on a short rise`, () => {
        expect(elbow({ x: 0, y: 5 }, { x: 100, y: 5 }, 50)).toBe(`M0 5 H100`);
        expect(elbow({ x: 0, y: 0 }, { x: 100, y: 6 }, 50)).toBe(`M0 0 H47 Q50 0 50 3 V3 Q50 6 53 6 H100`);
    });
});
