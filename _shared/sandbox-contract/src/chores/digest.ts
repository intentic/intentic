/* THE EVIDENCE DIGEST, the one idea that turns a nagging panel into something you can live with.
 *
 * A chore is due because of a measurement. Run the turn, and one of three things happens: the measurement moves
 * (the work landed), it stays put (the work is pending review, or the tool was wrong), or the tool reports
 * something else entirely next week. Only the first is "done", and none of them is answerable by a timestamp,
 * "ran 3 days ago" cannot tell you whether it ran against THIS.
 *
 * So a run records a hash of the evidence that provoked it. The next verdict compares:
 *   different digest  new evidence, nobody has looked at it → the rail may speak.
 *   same digest       already spent a turn on exactly this → still shown, never badged.
 * The consequence worth having is what happens when a person fixes something by hand: the evidence moves, the
 * digest changes, and the chore either goes quiet on its own merits or comes back honestly changed. No
 * bookkeeping, nothing to remember to tick off, and no way for the ledger to hide a problem that is really there.
 *
 * FNV-1a because it has to run identically in the daemon and in the browser, over strings this module builds
 * itself, with no dependency and no crypto import. Collisions here cost one missed badge, not a wrong answer. */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// >>> 0 after every step: JS bitwise operators produce signed 32-bit, and a negative intermediate would make the
// hash disagree with itself across engines that optimize the multiply differently.
export const digestOf = (...parts: readonly (string | number)[]): string => {
    const input = parts.join(`\u0000`);
    let hash = FNV_OFFSET;
    for (let index = 0; index < input.length; index++) {
        hash = ((hash ^ input.charCodeAt(index)) >>> 0) * FNV_PRIME;
        hash >>>= 0;
    }
    return hash.toString(36).padStart(7, `0`);
};

/* Buckets a count so that ordinary drift does not read as news. Twelve outdated packages becoming thirteen is not
 * a thing to interrupt someone about; twelve becoming forty is. Powers-of-two boundaries, so the bucket widens
 * with the number, the difference between 1 and 2 matters and the difference between 400 and 500 does not.
 *
 * This is the difference between a digest that changes on every poll (and therefore badges forever) and one that
 * changes when the situation does. Chores that count things digest the BUCKET; chores whose evidence is a set of
 * identities (advisory ids, package names) digest the identities, where every change is genuinely a new fact. */
// Zero is its OWN bucket rather than sharing one with 1: "none of these" becoming "one of these" is the moment a
// chore acquires a kind of finding it did not have, and a digest that cannot see that transition would let a
// chore's first unused dependency arrive in silence.
export const bucketOf = (count: number): number => (count <= 0 ? -1 : Math.floor(Math.log2(count)));
