/* COMPARING THE VERSIONS THIS SYSTEM STAMPS ON WHAT IT SHIPS, the daemon, the sandbox image, and the two agents
 * that run on a user's own computer. One release stamps all of them to the SAME version, so "is this one behind
 * that one" is one question with one answer, and it lives here because both ends ask it: the daemon compares its
 * own build against the latest published release, and the browser compares a computer's agent against the same.
 *
 * Shared rather than copied because the two copies would not disagree until the day it mattered — 1.9.0 against
 * 1.10.0 is where a hand-rolled comparator goes wrong, and it goes wrong by reporting "up to date". */

// Release versions are plain dotted numerics (semantic-release picks them), so there is no semver dependency to
// take on. A MISSING segment counts as 0, which is what makes "1.2" and "1.2.0" the same version rather than
// adjacent ones.
export const isNewer = (a: string, b: string): boolean => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l !== r) {
            return l > r;
        }
    }
    return false;
};

/* The sentinel every build that is NOT a release carries: the repo keeps 0.0.0 in package.json and only
 * semantic-release stamps a real one, so a working-tree daemon and a locally-compiled agent both answer this.
 *
 * It has to be excluded from the comparison rather than merely lose it. Every published release outranks 0.0.0,
 * so a developer running the agent they just built would be told, permanently, to replace it with something
 * older than what they are running. The daemon already draws exactly this line for itself (isDevBuild). */
export const DEV_VERSION = `0.0.0`;

/* WHETHER TO TELL SOMEBODY THEIR BUILD IS OLD. Deliberately false in every uncertain case, and each one is a
 * different kind of not-knowing:
 *
 *   • no installed version, the thing does not report one, so there is nothing to be behind.
 *   • no latest version, this sandbox has not reached the registry (or is a dev build and never will).
 *   • installed is the dev sentinel, see above; a nag that cannot be satisfied is worse than silence.
 *
 * A version that is not dotted-numeric is compared by its numeric prefix, which is both useful and safe in the
 * only direction that matters: a segment that will not parse compares as neither greater nor less, so it stops
 * the comparison at "not newer". A malformed INSTALLED version can therefore only ever withhold a nag, never
 * invent one, and `latest` comes from the registry, so it is well-formed by construction.
 *
 * The asymmetry is the point. Saying "you are out of date" wrongly sends someone to reinstall a working agent;
 * saying nothing wrongly leaves them where they already were. */
export const isBehind = (installed: string | undefined, latest: string | undefined): boolean =>
    installed !== undefined && latest !== undefined && installed !== DEV_VERSION && isNewer(latest, installed);
