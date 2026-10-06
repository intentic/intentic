// How a server cuts a UTF-8 file into text windows, and when a window is lossy. Shared by the two servers that do it:
// the sandbox daemon (/work) and the desktop app's folder server, so a file opens the same way from either. Pure byte
// work: the caller reads the bytes.

// A utf8 continuation byte (0b10xxxxxx): the middle of a character, never a cut point.
const isContinuation = (byte: number): boolean => (byte & 0b1100_0000) === 0b1000_0000;

// Bytes in a character from its lead byte: 4 for 0b11110xxx, 3 for 0b1110xxxx, 2 for 0b110xxxxx, else 1.
const sequenceLength = (byte: number): number => (byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1);

// Where a window's clean text starts and ends inside the bytes read for it.
export interface ByteRange {
    readonly start: number;
    readonly end: number;
}

// Trims a byte window to a clean decode: no partial character or line at a boundary that is not the file's own end
// (atStart/atEnd mark real file ends). A window with no newline (one long line) keeps its bytes; there is no line
// boundary to snap to.
export const trimUtf8Window = (bytes: Uint8Array, atStart: boolean, atEnd: boolean): ByteRange => {
    let start = 0;
    let end = bytes.length;
    if (!atStart) {
        // Enter on a character boundary, then skip past the partial line the window opened in.
        while (start < end && isContinuation(bytes[start] ?? 0)) {
            start += 1;
        }
        const newline = bytes.indexOf(0x0a, start);
        if (newline !== -1) {
            start = newline + 1;
        }
    }
    if (!atEnd) {
        const newline = bytes.lastIndexOf(0x0a, end - 1);
        if (newline !== -1 && newline >= start) {
            return { start, end: newline + 1 };
        }
        // No line boundary to cut on; walk back to the cut character's lead byte and keep it only if it's whole.
        let lead = end - 1;
        while (lead > start && isContinuation(bytes[lead] ?? 0)) {
            lead -= 1;
        }
        if (end - lead < sequenceLength(bytes[lead] ?? 0)) {
            end = lead;
        }
    }
    return { start, end };
};

// Whether bytes decode as UTF-8 with nothing replaced. A window is cut on character boundaries (above), so a UTF-8
// file's window always passes and a failure is the file's own: Latin-1, Windows-1252, or binary. Such a window is
// lossy: its text holds U+FFFD where bytes failed, and saving it back would write those over the file's bytes.
export const isUtf8 = (bytes: Uint8Array): boolean => {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
    } catch {
        // allow(silent-catch): the decoder's only complaint is the one this answers.
        return false;
    }
};
