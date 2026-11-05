// A SANDBOX'S SEGMENT OF AN ADDRESS (2026-11-05). `/s/<sandbox>/…` and `/home/<sandbox>/…` name the sandbox by its name
// and the tail of its platform id, `/s/intentic-zi4n3i/agents`, rather than by the whole id
// (`/s/cmtu1eqyv0001dawma7zi4n3i/agents`). The tail is the key: a cuid ends in random characters, and an address is
// only ever read against the sandboxes its reader lists, so six of them name one sandbox among those, and more are
// written only when another sandbox listed ends the same way. The name is for the reader and is not read back, so a
// renamed sandbox's old address still opens it. A whole id is read too, which is what an address from before this
// says, and what a writer that does not know the sandbox's name (the daemon's push) writes.

/** What a sandbox's segment is made from and read against: a row of the reader's list. */
export interface NamedSandbox {
    readonly id: string;
    readonly name: string;
}

/** The shortest tail of an id a segment carries. */
export const SEGMENT_KEY_LENGTH = 6;

// The longest the name's part runs, cut back to a whole word.
const SLUG_MAX = 40;

// Only an id of letters and digits has a tail to stand for it; any other is written whole.
const hasTail = (id: string): boolean => id.length > SEGMENT_KEY_LENGTH && /^[a-z0-9]+$/i.test(id);

/** A name as a segment's words: lowercase letters and digits, dashes between them, accents dropped. `` for none. */
export const sandboxSlug = (name: string): string => {
    const dashed = name
        .normalize(`NFKD`)
        .replace(/\p{M}+/gu, ``)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``);
    if (dashed.length <= SLUG_MAX) {
        return dashed;
    }
    const cut = dashed.slice(0, SLUG_MAX + 1);
    const wordEnd = cut.lastIndexOf(`-`);
    return (wordEnd > 0 ? cut.slice(0, wordEnd) : dashed.slice(0, SLUG_MAX)).replace(/-+$/, ``);
};

/**
 * The segment that names a sandbox among the ones listed (`intentic-zi4n3i`): its name's words and the shortest tail of
 * its id no other listed id ends with. An id with no tail to stand for it is written whole.
 */
export const sandboxSegment = (sandbox: NamedSandbox, listed: readonly NamedSandbox[]): string => {
    const { id } = sandbox;
    if (!hasTail(id)) {
        return id;
    }
    let length = SEGMENT_KEY_LENGTH;
    while (length < id.length && listed.some((other) => other.id !== id && other.id.endsWith(id.slice(-length)))) {
        length += 1;
    }
    if (length >= id.length) {
        return id;
    }
    const slug = sandboxSlug(sandbox.name);
    const key = id.slice(-length);
    return slug === `` ? key : `${slug}-${key}`;
};

/**
 * The listed sandbox a segment names: the one whose id it is, else the one whose id ends with its key (what follows its
 * last dash), the name's words deciding only between two that end alike. None when it names no listed sandbox.
 */
export const sandboxOfSegment = <Row extends NamedSandbox>(segment: string, listed: readonly Row[]): Row | undefined => {
    const whole = listed.find((row) => row.id === segment);
    if (whole !== undefined) {
        return whole;
    }
    const dash = segment.lastIndexOf(`-`);
    const key = segment.slice(dash + 1);
    if (key.length < SEGMENT_KEY_LENGTH) {
        return undefined;
    }
    const ending = listed.filter((row) => hasTail(row.id) && row.id.endsWith(key));
    if (ending.length <= 1) {
        return ending[0];
    }
    const slug = dash === -1 ? `` : segment.slice(0, dash);
    const named = ending.filter((row) => sandboxSlug(row.name) === slug);
    return named.length === 1 ? named[0] : undefined;
};
