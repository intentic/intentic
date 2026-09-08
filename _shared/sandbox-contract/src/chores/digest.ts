// A run records a hash of the evidence that provoked it: a matching digest means already spent a turn on this, a
// different one means the rail may speak. FNV-1a because it must run identically in the daemon and the browser, no
// dependency, no crypto import.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// >>> 0 after every step: a negative signed-32 intermediate would make the hash disagree across engines.
export const digestOf = (...parts: readonly (string | number)[]): string => {
    const input = parts.join(`\u0000`);
    let hash = FNV_OFFSET;
    for (let index = 0; index < input.length; index++) {
        hash = ((hash ^ input.charCodeAt(index)) >>> 0) * FNV_PRIME;
        hash >>>= 0;
    }
    return hash.toString(36).padStart(7, `0`);
};

// Buckets a count on power-of-two boundaries so ordinary drift isn't news (12→13 is nothing, 12→40 is); a
// counting chore digests the bucket, an identity-based one digests the identities directly.
// Zero is its own bucket, separate from 1: going from none to one is the moment a chore acquires a finding it
// didn't have, and that transition must not arrive silently.
export const bucketOf = (count: number): number => (count <= 0 ? -1 : Math.floor(Math.log2(count)));
