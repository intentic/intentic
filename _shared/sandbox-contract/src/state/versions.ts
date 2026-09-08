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
