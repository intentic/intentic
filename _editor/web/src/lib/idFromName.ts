// An id derived from the name someone typed, for the records people name and other records point at (an access profile,
// a service): nobody types an id, and the one made here is fixed at creation, so renaming moves the name and never what
// points at it. Lower-case words joined by `-`, which the contract's `entryId` takes; letters with marks lose them
// ("Księgowość" is `ksiegowosc`) rather than the word breaking apart. A name with nothing left to spell it by falls back
// to `fallback`, and an id already taken gets the first free `-2`, `-3`, so two names that fold alike both save.

// Letters NFKD does not take apart into a base and a mark.
const FOLDED = new Map([
    [`ł`, `l`],
    [`ß`, `ss`],
    [`ø`, `o`],
    [`æ`, `ae`],
    [`œ`, `oe`],
    [`đ`, `d`],
    [`ð`, `d`],
    [`þ`, `th`],
]);

// Room for a `-NN` suffix inside the contract's 60.
const MAX_BASE = 56;

export const idFromName = (name: string, taken: Iterable<string>, fallback: string): string => {
    const base =
        name
            .toLowerCase()
            .replace(/[łßøæœđðþ]/gu, (letter) => FOLDED.get(letter) ?? letter)
            .normalize(`NFKD`)
            .replace(/\p{M}/gu, ``)
            .replace(/[^a-z0-9]+/gu, `-`)
            .replace(/^-+|-+$/gu, ``)
            .slice(0, MAX_BASE)
            .replace(/-+$/u, ``) || fallback;
    const used = new Set(taken);
    if (!used.has(base)) {
        return base;
    }
    let n = 2;
    while (used.has(`${base}-${n}`)) {
        n += 1;
    }
    return `${base}-${n}`;
};
