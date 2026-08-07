// Minimal matcher for a manifest's `engines.intentic` range against the host's extension API version: an exact
// version ("0.1.0") or a caret range ("^0.1", "^1", "^1.2.3"). Caret follows semver — same major at or above
// the floor, and while the major is 0 the minor is breaking too. Anything unparseable fails closed: the loader
// reports the extension incompatible rather than activating on a guess.

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
    const floor = parse(caret ? range.trim().slice(1) : range);
    if (host === undefined || floor === undefined) {
        return false;
    }
    if (!caret) {
        return host[0] === floor[0] && host[1] === floor[1] && host[2] === floor[2];
    }
    if (host[0] !== floor[0] || (floor[0] === 0 && host[1] !== floor[1])) {
        return false;
    }
    if (host[1] !== floor[1]) {
        return host[1] > floor[1];
    }
    return host[2] >= floor[2];
};
