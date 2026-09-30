// UTF-16 text, which a file announces with a byte-order mark in its first two bytes. Windows still writes it for
// desktop.ini, .reg exports and Windows PowerShell's redirects. Read as UTF-8, every other byte of it is NUL and the
// file looks binary. Shared by the two servers that cut a file into text windows: the sandbox daemon and the desktop
// app's folder server.

export type Utf16 = "utf-16le" | "utf-16be";

// The UTF-16 a file's first bytes announce, or undefined for any other file.
export const utf16ByBom = (head: Uint8Array): Utf16 | undefined => {
    if (head[0] === 0xff && head[1] === 0xfe) {
        return "utf-16le";
    }
    return head[0] === 0xfe && head[1] === 0xff ? "utf-16be" : undefined;
};

// How many bytes before a window its reader should hand over as well: the one code unit that says whether the window
// opens at a line's start.
export const UTF16_PROBE = 2;

export interface Utf16Window {
    readonly content: string;
    // The byte range of the file that `content` decodes.
    readonly offset: number;
    readonly bytes: number;
}

const NEWLINE = 0x0a;
const isHighSurrogate = (unit: number): boolean => unit >= 0xd8_00 && unit <= 0xdb_ff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc_00 && unit <= 0xdf_ff;

// Cuts a UTF-16 file's window the way a UTF-8 one is cut: on code units and, away from the file's own ends, on whole
// lines. `read` is the file's bytes from `from - probe`, the probe being up to UTF16_PROBE bytes before the window. The
// BOM is dropped from the text but stays in the byte range, so a window from the start still reports offset 0.
export const decodeUtf16Window = (read: Uint8Array, probe: number, from: number, size: number, encoding: Utf16): Utf16Window => {
    const unitAt = (index: number): number =>
        encoding === "utf-16le" ? (read[index] ?? 0) | ((read[index + 1] ?? 0) << 8) : ((read[index] ?? 0) << 8) | (read[index + 1] ?? 0);
    // Code units start at even offsets of the file, behind its two-byte BOM.
    let start = probe + (from % 2);
    let end = start + Math.floor((read.length - start) / 2) * 2;
    // Just behind the BOM is still the first line.
    const lineStart = from - probe + start <= UTF16_PROBE || (start >= 2 && unitAt(start - 2) === NEWLINE);
    if (!lineStart) {
        let newline = -1;
        for (let index = start; index + 1 < end; index += 2) {
            if (unitAt(index) === NEWLINE) {
                newline = index;
                break;
            }
        }
        if (newline !== -1) {
            start = newline + 2;
        } else if (start < end && isLowSurrogate(unitAt(start))) {
            start += 2;
        }
    }
    if (from - probe + read.length < size) {
        let newline = -1;
        for (let index = end - 2; index >= start; index -= 2) {
            if (unitAt(index) === NEWLINE) {
                newline = index;
                break;
            }
        }
        if (newline !== -1) {
            end = newline + 2;
        } else if (end - 2 >= start && isHighSurrogate(unitAt(end - 2))) {
            end -= 2;
        }
    } else {
        // The file's own end keeps a stray last byte, which decodes to a replacement character rather than vanishing.
        end = read.length;
    }
    // The decoder drops a leading BOM itself.
    const content = new TextDecoder(encoding).decode(read.subarray(start, end));
    return { content, offset: from - probe + start, bytes: end - start };
};
