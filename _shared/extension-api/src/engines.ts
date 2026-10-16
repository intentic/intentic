import { compareVersions } from "@intentic/sandbox-contract/state/versions";

// Minimal matcher for a manifest's `engines.intentic` range against the host's extension API version: an exact
// version ("0.1.0") or a caret range ("^0.1", "^1", "^1.2.3"). Caret follows semver, same major at or above
// the floor, and while the major is 0 the minor is breaking too. Anything unparseable fails closed: the loader
// reports the extension incompatible rather than activating on a guess.

// Stricter than the contract's version reader on purpose: no `v`, no prerelease, at most three parts, since an engines
// range that reads loosely is one an extension activates on by accident. The ordering itself is the contract's.
const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
    if (match === null) {
        return undefined;
    }
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
};

export const satisfiesEngines = (range: string, version: string): boolean => {
    const host = parse(version);
    const caret = range.trim().startsWith(`^`);
    const bound = caret ? range.trim().slice(1) : range;
    const floor = parse(bound);
    if (host === undefined || floor === undefined) {
        return false;
    }
    const order = compareVersions(version.trim(), bound.trim());
    if (!caret) {
        return order === 0;
    }
    // Inside the caret's compatible span: the same major, and while the major is 0 the same minor too.
    return host[0] === floor[0] && (floor[0] !== 0 || host[1] === floor[1]) && order >= 0;
};
