// WHICH GITHUB OR GITLAB CONNECTION READS A REPOSITORY, when a plugin or an extension is installed from one without a
// token of its own. One rule for the install form, which says which connection it will use, and for the daemon, which
// clones with it: the two sides read the same list of connections, so they cannot name different ones.

// A connection as either side holds it: the daemon a `cli` entry's config, the editor the list's echo of it
// (CapabilitySummary). Only the non-secret fields are read (`provider`, a GitLab instance's `url`, the `git` switch),
// which both sides have.
export interface GitConnectionCandidate {
    readonly id: string;
    readonly kind: string;
    readonly config: Readonly<Record<string, string | number | boolean>>;
}

export interface GitConnection {
    readonly id: string;
    readonly provider: "github" | "gitlab";
    // The host its token is good for: github.com, or the GitLab instance's host (with a port, when it has one).
    readonly host: string;
}

/** The provider's name as a person reads it. */
export const gitProviderName = (provider: GitConnection["provider"]): string => (provider === "github" ? "GitHub" : "GitLab");

/** The host a GitHub or GitLab card's token answers for, or undefined for any other card or an unreadable instance URL. */
export const gitConnectionOf = (candidate: GitConnectionCandidate): GitConnection | undefined => {
    const { provider, url, git } = candidate.config;
    // Git access switched off on the card is the owner saying its token is not for git.
    if (candidate.kind !== "cli" || git === "off") {
        return undefined;
    }
    if (provider === "github") {
        return { id: candidate.id, provider, host: "github.com" };
    }
    if (provider !== "gitlab") {
        return undefined;
    }
    const host = URL.parse(String(url ?? ""))?.host.toLowerCase() ?? "";
    return host === "" ? undefined : { id: candidate.id, provider, host };
};

/** The repository's host, for an http(s) URL; undefined for anything git would reach another way (ssh, a path). */
export const gitUrlHost = (url: string): string | undefined => {
    const parsed = URL.parse(url.trim());
    return parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.host === "" ? undefined : parsed.host.toLowerCase();
};

// The scheme a card's token may travel over: https, or plain http only for a GitLab instance the owner set up at an
// http address themselves. An `http://github.com/…` typed on a plugin card must never carry the GitHub token in clear.
const lendsOver = (candidate: GitConnectionCandidate, connection: GitConnection, protocol: string): boolean =>
    protocol === "https:" || (connection.provider === "gitlab" && URL.parse(String(candidate.config["url"] ?? ""))?.protocol === protocol);

/**
 * The connections whose token is good for the repository's host, in the order the first of them is chosen: by id, so
 * the pick never depends on which card was connected first or on the list's order.
 */
export const gitConnectionsFor = (candidates: readonly GitConnectionCandidate[], url: string): readonly GitConnection[] => {
    const host = gitUrlHost(url);
    const protocol = URL.parse(url.trim())?.protocol;
    if (host === undefined || protocol === undefined) {
        return [];
    }
    return candidates
        .flatMap((candidate) => {
            const connection = gitConnectionOf(candidate);
            return connection !== undefined && connection.host === host && lendsOver(candidate, connection, protocol) ? [connection] : [];
        })
        .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
};
