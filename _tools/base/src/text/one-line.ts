// Text from somewhere else (a prompt, a commit label, a provider's error, an email subject) as one bounded line for a
// title, a log row or a terminal. One copy because the copies drifted: some kept ESC and BEL (a terminal acts on them),
// some kept bidi overrides (a label that reads backwards), some cut a surrogate pair in half, and some put the `…` past
// their own limit.

export interface OneLineOptions {
    // What marks a cut; `false` cuts silently, for a value compared or stored where a marker would be noise.
    readonly ellipsis?: string | false;
}

// Line and paragraph breaks, tabs and every other space become one space: \s covers \n, \r, \t, U+2028 and U+2029.
const SPACE = /\s+/gu;
// What is left of the control (Cc) and format (Cf) characters once whitespace is a space: ESC, BEL, NUL, bidi overrides
// and isolates, zero-width spaces. Removed rather than spaced, since they sit inside words.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

// The longest start of `text` at most `units` UTF-16 code units long that does not end inside a surrogate pair.
const cutAt = (text: string, units: number): string => {
    const high = text.charCodeAt(units - 1);
    return text.slice(0, high >= 0xd800 && high <= 0xdbff ? units - 1 : units);
};

// `text` flattened to one line and, past `max`, cut to fit with the ellipsis INSIDE `max`. Length is counted as
// String.length counts it (UTF-16 code units), the measure every schema's `max` applies, and a cut never splits a
// character in two.
export const oneLine = (text: string, max = Number.POSITIVE_INFINITY, options: OneLineOptions = {}): string => {
    const flat = text.replaceAll(SPACE, " ").replaceAll(INVISIBLE, "").replaceAll(SPACE, " ").trim();
    if (flat.length <= max) {
        return flat;
    }
    const ellipsis = options.ellipsis === false ? "" : (options.ellipsis ?? "…");
    if (ellipsis.length >= max) {
        return cutAt(flat, Math.max(0, max));
    }
    return `${cutAt(flat, max - ellipsis.length).trimEnd()}${ellipsis}`;
};
