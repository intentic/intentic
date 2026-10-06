import "@intentic/testing/dom";
import { parseTerminalMetas } from "./terminalMeta";

// Overrides are read back per terminal: a stored entry this build cannot draw (a color or icon it no longer offers, a
// value of the wrong kind) costs that terminal its override and leaves the others as they were. They were cast whole,
// so a retired color reached the pill as an undefined swatch.

it(`keeps the overrides this build can draw and drops each one it cannot`, () => {
    const stored = JSON.stringify({
        "web-1": { label: `api`, color: `cyan`, icon: `star` },
        "web-2": { color: `teal` },
        "web-3": { label: 7 },
        "web-4": `blue`,
    });

    expect(parseTerminalMetas(stored)).toEqual({ "web-1": { label: `api`, color: `cyan`, icon: `star` } });
});

it(`reads nothing stored, text that is not JSON, or a list, as no overrides`, () => {
    expect([parseTerminalMetas(null), parseTerminalMetas(`{oops`), parseTerminalMetas(`[1,2]`)]).toEqual([{}, {}, {}]);
});
