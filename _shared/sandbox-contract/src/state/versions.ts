// Compares versions this system stamps on the daemon, sandbox image and device agents; one release stamps all of them
// the same, so both ends can ask "is this behind" with a shared comparator. A hand-rolled duplicate wouldn't disagree
// until 1.9.0 vs 1.10.0 broke it.

// Plain dotted numerics, no semver dependency needed. A missing segment counts as 0, so "1.2" and "1.2.0" compare
// equal.
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

// Sentinel for a non-release build; excluded from comparison rather than merely outranked by every release.
export const DEV_VERSION = `0.0.0`;

// False whenever uncertain: no installed version, no latest version, or installed is the dev sentinel.
// A malformed version compares as not-newer only, so it can withhold a nag but never invent one.
export const isBehind = (installed: string | undefined, latest: string | undefined): boolean =>
    installed !== undefined && latest !== undefined && installed !== DEV_VERSION && isNewer(latest, installed);

// A version read as semver: a leading `v` tolerated, any number of dotted numeric parts (a missing one is 0), a
// prerelease after `-`, and build metadata after `+`, which never orders anything.
export interface ParsedVersion {
    readonly parts: readonly number[];
    // The dot-separated prerelease identifiers; empty for a release.
    readonly prerelease: readonly string[];
}

const VERSION = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i;

// Undefined for anything that is not a version (`unknown`, `latest`, an empty string).
export const parseVersion = (version: string): ParsedVersion | undefined => {
    const match = VERSION.exec(version.trim());
    if (match === null) {
        return undefined;
    }
    return { parts: match[1]!.split(`.`).map(Number), prerelease: match[2] === undefined ? [] : match[2].split(`.`) };
};

// Semver's rule for one identifier: numbers numerically and below words, words by ASCII.
const compareIdentifier = (left: string, right: string): number => {
    const [leftNumeric, rightNumeric] = [/^\d+$/.test(left), /^\d+$/.test(right)];
    if (leftNumeric && rightNumeric) {
        return Number(left) - Number(right);
    }
    if (leftNumeric !== rightNumeric) {
        return leftNumeric ? -1 : 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
};

const comparePrerelease = (left: readonly string[], right: readonly string[]): number => {
    // A release outranks every prerelease of itself: 1.2.0 > 1.2.0-rc.1.
    if (left.length === 0 || right.length === 0) {
        return right.length - left.length;
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const [l, r] = [left[index], right[index]];
        if (l === undefined || r === undefined) {
            // Equal so far, so the longer set of identifiers is the later one: rc.1.1 > rc.1.
            return l === undefined ? -1 : 1;
        }
        const difference = compareIdentifier(l, r);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
};

// Negative when `a` is older, positive when newer, zero when the same release, as a sort comparator wants (sort
// descending with `(a, b) => compareVersions(b, a)`). Anything that does not parse sorts below every version and
// equal to anything else that does not parse, so "unknown" never outranks a real release. `isNewer` above stays the
// numeric-only reading the update nag is built on, which treats a prerelease segment as uncertainty.
export const compareVersions = (a: string, b: string): number => {
    const [left, right] = [parseVersion(a), parseVersion(b)];
    if (left === undefined || right === undefined) {
        return (left === undefined ? 0 : 1) - (right === undefined ? 0 : 1);
    }
    for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
        const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
        if (difference !== 0) {
            return Math.sign(difference);
        }
    }
    return Math.sign(comparePrerelease(left.prerelease, right.prerelease));
};
