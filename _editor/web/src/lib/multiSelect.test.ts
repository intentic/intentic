import { clickIntent, rangeSelect } from "./multiSelect";

const keys = (held: Partial<Pick<MouseEvent, `shiftKey` | `ctrlKey` | `metaKey`>> = {}) => ({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...held,
});

describe(`clickIntent`, () => {
    it.each([
        [`a plain click`, keys(), true, `single`],
        [`Shift`, keys({ shiftKey: true }), true, `range`],
        [`Shift over Ctrl`, keys({ shiftKey: true, ctrlKey: true }), true, `range`],
        [`Ctrl`, keys({ ctrlKey: true }), true, `toggle`],
        [`Cmd`, keys({ metaKey: true }), true, `toggle`],
        [`Shift with no anchor`, keys({ shiftKey: true }), false, `single`],
        [`Shift and Ctrl with no anchor`, keys({ shiftKey: true, ctrlKey: true }), false, `toggle`],
    ] as const)(`reads %s as the rule says`, (_, held, anchored, intent) => {
        expect(clickIntent(held, anchored)).toBe(intent);
    });
});

describe(`rangeSelect`, () => {
    const order = [`a`, `b`, `c`, `d`];
    it.each([
        [`forwards`, `b`, `d`, [`b`, `c`, `d`]],
        [`backwards`, `d`, `b`, [`b`, `c`, `d`]],
        [`onto the anchor itself`, `c`, `c`, [`c`]],
        [`from an anchor no longer listed`, `gone`, `c`, [`c`]],
        [`from no anchor`, undefined, `c`, [`c`]],
        [`to a row not listed`, `a`, `gone`, undefined],
    ] as const)(`ranges %s`, (_, anchor, row, range) => {
        expect(rangeSelect(order, anchor, row)).toEqual(range === undefined ? undefined : [...range]);
    });
});
