// What a peek may claim about a file it has only read the ends of. Pins the two claims that would be lies: a line
// count derived from a clipped window, and a fragment of a line drawn as though it were a line.
import { dropPartialFirst, dropPartialLast, type FilePeek, isAudioPath, isImagePath, peekLead, peekLines, peekOmitted } from "./filePeek";

const peek = (over: Partial<FilePeek> = {}): FilePeek => ({
    present: true,
    size: 12,
    head: `one\ntwo\nthree`,
    headBytes: 12,
    tailBytes: 0,
    binary: false,
    ...over,
});

it("counts lines only when the window reached the end of the file", () => {
    expect(peekLines(peek())).toBe(3);
    // The same three lines, but from the first 12 bytes of a much longer file: three is now a fact about the window.
    expect(peekLines(peek({ size: 900_000 }))).toBeUndefined();
});

it("has no line count for a file that is missing, binary or empty of text", () => {
    expect(peekLines(peek({ present: false }))).toBeUndefined();
    expect(peekLines(peek({ binary: true, head: `` }))).toBeUndefined();
    expect(peekLines(peek({ head: ``, size: 0, headBytes: 0 }))).toBe(0);
    // A trailing newline ends the last line, it doesn't start another.
    expect(peekLines(peek({ head: `one\ntwo\n` }))).toBe(2);
});

it("drops the fragment of a line each window boundary cuts", () => {
    expect(dropPartialLast(`21:26 INFO up\n21:27 WARN ret`)).toBe(`21:26 INFO up`);
    expect(dropPartialFirst(`7 ERROR gave up\n21:41 ERROR done`)).toBe(`21:41 ERROR done`);
});

// One enormous line (a minified bundle, a single-line JSON) is not a fragment: cutting it would leave nothing at all.
it("keeps a window with no line break in it at all", () => {
    expect(dropPartialLast(`{"a":1,"b":2`)).toBe(`{"a":1,"b":2`);
});

it("states the bytes neither window quotes", () => {
    expect(peekOmitted(peek({ size: 100_000, headBytes: 8_192, tailBytes: 8_192 }))).toBe(83_616);
    // Head and tail together covering the file leave nothing to announce.
    expect(peekOmitted(peek({ size: 12, headBytes: 12, tailBytes: 0 }))).toBe(0);
});

// Log preambles start with blank lines and banner rules; a lead that honoured them would preview nothing.
it("leads with the first lines that actually say something", () => {
    const lines = peekLead(peek({ head: `\n   \n21:26 INFO starting  \n21:27 WARN retry\n21:28 ERROR gave up` }), 2);
    expect(lines).toEqual([`21:26 INFO starting`, `21:27 WARN retry`]);
});

it("knows which attachments have a thumbnail instead", () => {
    expect(isImagePath(`shots/Screen.PNG`)).toBe(true);
    expect(isImagePath(`logs/desktop-setup.log`)).toBe(false);
    expect(isImagePath(`Makefile`)).toBe(false);
});

// The two faces are exclusive by construction — a path that answered to both would get a thumbnail AND a player,
// and the caches behind them key one URL per path.
it("knows which attachments have a waveform instead, and never both", () => {
    expect(isAudioPath(`calls/Standup.M4A`)).toBe(true);
    expect(isAudioPath(`calls/note.opus`)).toBe(true);
    expect(isAudioPath(`shots/Screen.PNG`)).toBe(false);
    expect(isAudioPath(`logs/desktop-setup.log`)).toBe(false);
    // `.ogv` is video in the same family of containers; only what an <audio> element decodes belongs here.
    expect(isAudioPath(`clips/demo.ogv`)).toBe(false);
});
