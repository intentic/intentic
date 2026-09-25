import { CLOSED, type QuickBar, type QuickBarEvent, stepQuickBar } from "./quickBarHold";

// Pins what each gesture does to the parked chat's box and its transcript, apart from when a hover counts (the
// component's clocks). Every case walks from the closed bar, so a row reads as a sequence a reader could perform.

const walk = (...events: QuickBarEvent[]): QuickBar => events.reduce(stepQuickBar, CLOSED);
const hover: QuickBarEvent = { kind: `open`, keep: false, asking: false };
const press: QuickBarEvent = { kind: `open`, keep: true, asking: false };

describe(`the box`, () => {
    it(`is borrowed by a hover, kept by a press, and kept by a press after a hover`, () => {
        expect([walk(hover), walk(press), walk(hover, press), walk(press, hover)]).toEqual([
            { box: `borrowed`, peek: `closed` },
            { box: `kept`, peek: `closed` },
            { box: `kept`, peek: `closed` },
            { box: `kept`, peek: `closed` },
        ]);
    });

    it(`opens for nothing while a question waits, and leaves a box already open as it is`, () => {
        expect([walk({ kind: `open`, keep: true, asking: true }), walk(hover, { kind: `open`, keep: true, asking: true })]).toEqual([
            CLOSED,
            { box: `borrowed`, peek: `closed` },
        ]);
    });

    it(`goes back with the pointer only when borrowed and empty`, () => {
        expect([
            walk(hover, { kind: `leave`, words: false }),
            walk(hover, { kind: `leave`, words: true }),
            walk(press, { kind: `leave`, words: false }),
            walk(hover, { kind: `focus` }, { kind: `leave`, words: false }),
        ]).toEqual([CLOSED, { box: `borrowed`, peek: `closed` }, { box: `kept`, peek: `closed` }, { box: `kept`, peek: `closed` }]);
    });

    it(`folds on a press on the page unless it holds words, which it then holds only as a pointer would`, () => {
        expect([
            walk(press, { kind: `release`, words: false }),
            walk(press, { kind: `release`, words: true }),
            walk(press, { kind: `release`, words: true }, { kind: `leave`, words: false }),
        ]).toEqual([CLOSED, { box: `borrowed`, peek: `closed` }, CLOSED]);
    });
});

describe(`the transcript`, () => {
    it(`is borrowed by the eye's hover and goes with the pointer, before the box does`, () => {
        const peeking = walk(hover, { kind: `peek`, keep: false });
        expect([peeking, stepQuickBar(peeking, { kind: `peekLeave` })]).toEqual([
            { box: `borrowed`, peek: `borrowed` },
            { box: `borrowed`, peek: `closed` },
        ]);
    });

    it(`is kept by the eye's press, with the box, and folded by the next`, () => {
        const kept = walk(hover, { kind: `peek`, keep: true });
        expect([kept, stepQuickBar(kept, { kind: `peekLeave` }), stepQuickBar(kept, { kind: `peek`, keep: true })]).toEqual([
            { box: `kept`, peek: `kept` },
            { box: `kept`, peek: `kept` },
            { box: `kept`, peek: `closed` },
        ]);
    });

    it(`is kept with the box by a press on the content, so a selection survives the pointer leaving`, () => {
        expect(walk(hover, { kind: `peek`, keep: false }, { kind: `press` }, { kind: `peekLeave` }, { kind: `leave`, words: false })).toEqual({
            box: `kept`,
            peek: `kept`,
        });
    });

    it(`needs an open box to open over`, () => {
        expect(walk({ kind: `peek`, keep: true })).toEqual(CLOSED);
    });
});

it(`undoes one thing per Escape, the transcript first, and folds everything on minimize`, () => {
    const open = walk(press, { kind: `peek`, keep: true });
    const once = stepQuickBar(open, { kind: `escape` });
    expect([once, stepQuickBar(once, { kind: `escape` }), stepQuickBar(open, { kind: `fold` })]).toEqual([
        { box: `kept`, peek: `closed` },
        CLOSED,
        CLOSED,
    ]);
});
