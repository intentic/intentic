// A sandbox's names as they are read back: the slug off a container name or a daemon's address, and the 12-hex id off a
// connect token. No Node and no other import, so the browser editor takes this subpath without pulling in the run
// contract's docker-run emitter. Before this, ten callers each read a slug off a URL their own way: one threw on an
// address that would not parse, inside a render, and they disagreed on case.

// Every container name below the workspace one is this plus a slug; exported so reading a slug back off a name is the
// same string as writing it (`sandboxSlugOf`), not a regex copied per caller. `ic` and the desktop app spell it again
// in Rust, which cannot import it: names.fixture.json is the one record all three are tested against.
export const SANDBOX_CONTAINER_PREFIX = "intentic-sandbox-";

// The slug inside a container name, or undefined for a name that is not one (an empty env, another project's
// container). Never guesses: a caller with no slug has to say so rather than aim an action at a plausible one.
export const sandboxSlugOf = (container: string | undefined): string | undefined => {
    const slug = container?.startsWith(SANDBOX_CONTAINER_PREFIX) === true ? container.slice(SANDBOX_CONTAINER_PREFIX.length) : undefined;
    return slug === "" ? undefined : slug;
};

// The first label of a hostname, lowercased as DNS reads it: the slug `ic sandbox connect` names a container by
// (connect.rs) and the launcher addresses it by. Undefined for an empty one.
export const slugOfHostname = (hostname: string | undefined): string | undefined => {
    const label = hostname?.split(".")[0]?.toLowerCase();
    return label === undefined || label === "" ? undefined : label;
};

// The slug in a daemon's address. Best-effort by design: behind an owner's own Cloudflare zone the subdomain need not be
// the slug, so a caller matches it against what a machine reports rather than acting on it blind. Undefined for no
// address or one that does not parse, never a throw, since this runs inside renders.
export const slugOfDaemonUrl = (daemonUrl: string | null | undefined): string | undefined =>
    daemonUrl === null || daemonUrl === undefined || !URL.canParse(daemonUrl) ? undefined : slugOfHostname(new URL(daemonUrl).hostname);

// The sandbox's stable 12-hex id from its connect token, through Web Crypto so a browser derives it too: the twin of
// the contract's `sandboxIdFromToken` (node:crypto), and byte for byte the same digest. Undefined for an empty token,
// as that one answers.
export const sandboxIdOfToken = async (connectToken: string): Promise<string | undefined> => {
    if (connectToken === "") {
        return undefined;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(connectToken));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 12);
};
