import { STALE_NOTICE_HEADER, stripInjectedPreamble, TURN_PREAMBLE_SEPARATOR } from "./turn-preamble.js";

const SEP = TURN_PREAMBLE_SEPARATOR;

test("a note opening with a heading comes off at the first separator, and only there", () => {
    expect(stripInjectedPreamble(`## Map of this project\n\nfour areas${SEP}fix the bug${SEP}and the rest of what I wrote`)).toBe(
        `fix the bug${SEP}and the rest of what I wrote`,
    );
});

test("a dependency notice, which opens without a heading, comes off too", () => {
    expect(stripInjectedPreamble(`${STALE_NOTICE_HEADER}, so an unresolved import is expected.${SEP}fix the bug`)).toBe("fix the bug");
});

test("a note-like opening with no separator is left whole", () => {
    expect(stripInjectedPreamble("## Rotation plan\n\nfix the bug")).toBe("## Rotation plan\n\nfix the bug");
});

test("any other opening is left whole, separator and all", () => {
    expect(stripInjectedPreamble(`# Notes${SEP}fix the bug`)).toBe(`# Notes${SEP}fix the bug`);
    expect(stripInjectedPreamble(`fix the bug${SEP}## Map of this project`)).toBe(`fix the bug${SEP}## Map of this project`);
});
