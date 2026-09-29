// Which hosts a stored secret may be sent to: an owner's list per secret, matched against the hosts one use would reach.
// Shared by the daemon's check, its routes and the Secrets view, so the three cannot disagree on what a pattern means.
// A list names hosts, never ports or paths: the question it answers is who receives the value, not which door.

// One DNS label: letters, digits and inner hyphens, at most 63 characters.
const LABEL = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;

// An exact host (`api.github.com`, `localhost`, `10.0.0.2`) or every host under a domain (`*.github.com`). A wildcard
// names at least two labels under it, so `*.com` cannot stand in for most of the internet.
export const SECRET_HOST_PATTERN_RE = new RegExp(String.raw`^(?:\*\.${LABEL}(?:\.${LABEL})+|${LABEL}(?:\.${LABEL})*)$`);
export const SECRET_HOST_MAX = 253;
// Enough for a service's API, uploads and content hosts several times over; a list longer than this is no limit.
export const SECRET_HOSTS_MAX = 64;

const WILDCARD = "*.";

// What a person types or pastes, as the pattern it means: lowercased, trimmed, a trailing dot and a port dropped, and a
// whole URL reduced to its host. Undefined for anything that is not a host pattern, so a caller refuses it by name.
export const normalizeHostPattern = (raw: string): string | undefined => {
    let text = raw.trim().toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
        try {
            text = new URL(text).hostname;
        } catch {
            return undefined;
        }
    }
    text = text.replace(/:\d+$/, "").replace(/\.$/, "");
    return text.length <= SECRET_HOST_MAX && SECRET_HOST_PATTERN_RE.test(text) ? text : undefined;
};

// A host a use would reach, in the form patterns are written in: lowercased, one trailing dot dropped. Undefined when it
// is not a plain host name or IPv4 address, which callers read as "cannot tell where this goes".
export const normalizeHost = (raw: string): string | undefined => {
    const host = raw.toLowerCase().replace(/\.$/, "");
    return host.length <= SECRET_HOST_MAX && !host.startsWith(WILDCARD) && SECRET_HOST_PATTERN_RE.test(host) ? host : undefined;
};

// `*.github.com` matches every host under github.com at any depth, and not github.com itself; anything else matches only
// itself. Both sides are expected normalized.
export const hostMatches = (pattern: string, host: string): boolean =>
    pattern.startsWith(WILDCARD) ? host.endsWith(pattern.slice(1)) : host === pattern;

export const hostAllowed = (patterns: readonly string[], host: string): boolean => patterns.some((pattern) => hostMatches(pattern, host));

// Whether every host `pattern` matches is already matched by `patterns`: an exact host by any pattern that matches it, a
// wildcard only by itself or a wildcard over a domain above it.
const covered = (patterns: readonly string[], pattern: string): boolean => {
    if (!pattern.startsWith(WILDCARD)) {
        return hostAllowed(patterns, pattern);
    }
    const suffix = pattern.slice(1);
    return patterns.some((held) => held.startsWith(WILDCARD) && suffix.endsWith(held.slice(1)));
};

// One secret's host guard as a change reads it: whether it asks off the list, and the list. Absent reads as off.
export interface HostGuardSetting {
    readonly guard: boolean;
    readonly hosts: readonly string[];
}

// Whether going from `current` to `next` only ever makes the agent ask more: turning the guard on, or taking hosts off a
// guarded list (down to none, where every use asks). The one test for who may make a change: anybody who may use
// secrets may tighten a guard, only the owner may loosen one, by adding a host or turning it off.
export const tightensHostGuard = (current: HostGuardSetting | undefined, next: HostGuardSetting): boolean => {
    if (!next.guard) {
        return current === undefined || !current.guard;
    }
    if (current === undefined || !current.guard) {
        return true;
    }
    return next.hosts.every((pattern) => covered(current.hosts, pattern));
};
