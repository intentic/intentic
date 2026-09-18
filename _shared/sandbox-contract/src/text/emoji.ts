// What counts as one emoji, for anywhere a person picks one rather than types a sentence (a conversation's reactions).
// Shared so the field that accepts the press and the route that stores it cannot disagree about what was pressed.

// The unit is the grapheme, not the code point: a flag, a skin-toned wave and a seven-code-point family all render as
// one mark, and one mark is what a chip draws and a person presses.
const graphemes = new Intl.Segmenter(undefined, { granularity: `grapheme` });

// Two escapes ride alongside the pictographic property rather than under it, because neither is one: a keycap (1️⃣) is a
// plain ASCII digit plus U+20E3, and a country flag (🇵🇱) is a pair of regional indicators.
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{20E3}]/u;

// A single grapheme is long enough to matter — a subdivision flag is 28 UTF-16 units — so this bounds the string before
// segmenting it, and never stands in for the grapheme count itself.
export const EMOJI_MAX_LENGTH = 64;

// True for exactly one emoji grapheme. False for two of them, for a letter, and for an empty string: a reaction is one
// press, and a chip has room for one mark.
export const isSingleEmoji = (text: string): boolean => {
    if (text.length === 0 || text.length > EMOJI_MAX_LENGTH || !PICTOGRAPHIC.test(text)) {
        return false;
    }
    const segments = graphemes.segment(text)[Symbol.iterator]();
    return segments.next().done !== true && segments.next().done === true;
};
