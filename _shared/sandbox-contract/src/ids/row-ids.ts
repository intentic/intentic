// A transcript row's own name (TranscriptRow.rowId). Minted once, where the row is made: the live fold for a run's rows,
// the record for a row written outside a run. Random rather than counted, since two makers (a run and a placed line) can
// write into one conversation without asking each other, and nothing reads order out of it: position is the record's.

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
// Twelve characters of base 36, about 62 bits: unique within any conversation by a wide margin, and short, since every
// row of every record carries one.
const LENGTH = 12;

export const newRowId = (): string => {
    let id = "";
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(LENGTH))) {
        id += ALPHABET[byte % ALPHABET.length];
    }
    return id;
};

// The name of a row recorded before rows had ids: its position, which never moves for a row that stays (a rewind only
// drops rows after the point it keeps, and what is written after gets minted ids). The `@` keeps it apart from a minted id.
export const positionRowId = (position: number): string => `@${position}`;
