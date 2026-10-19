// A NEW PASSWORD, for the editor's Generate: 20 characters from letters, digits and a few symbols every site accepts,
// with at least one of each kind, drawn from the platform's cryptographic random source. Unbiased: a byte past the last
// whole multiple of the alphabet's length is drawn again rather than folded in.

const LOWER = `abcdefghijkmnopqrstuvwxyz`;
const UPPER = `ABCDEFGHJKLMNPQRSTUVWXYZ`;
const DIGITS = `23456789`;
// Symbols that survive a shell, a URL and a CSV unquoted; the look-alikes (l, I, O, 0, 1) are left out above.
const SYMBOLS = `-_.!@#%+=`;
const ALL = `${LOWER}${UPPER}${DIGITS}${SYMBOLS}`;

// A number below `count` (at most 256), every one equally likely.
const below = (count: number, random: () => number): number => {
    const limit = 256 - (256 % count);
    for (;;) {
        const byte = random();
        if (byte < limit) {
            return byte % count;
        }
    }
};

const pick = (alphabet: string, random: () => number): string => alphabet.charAt(below(alphabet.length, random));

const cryptoByte = (): number => crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;

export const generatePassword = (length = 20, random: () => number = cryptoByte): string => {
    const chars = [pick(LOWER, random), pick(UPPER, random), pick(DIGITS, random), pick(SYMBOLS, random)];
    while (chars.length < length) {
        chars.push(pick(ALL, random));
    }
    // Shuffled, so the four guaranteed kinds are not always the first four characters.
    for (let index = chars.length - 1; index > 0; index--) {
        const other = below(index + 1, random);
        [chars[index], chars[other]] = [chars[other] ?? ``, chars[index] ?? ``];
    }
    return chars.join(``);
};
