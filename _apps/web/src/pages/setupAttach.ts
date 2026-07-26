/* The "I already run my sandbox behind a domain that works" path of /setup — the one-step alternative to
 * provision-a-tunnel → run-a-command → wait-for-the-announce. Nothing is provisioned and nothing phones home,
 * so the BROWSER is what verifies the URL: the platform never calls into a sandbox, and "can this browser reach
 * it" is the only question that matters anyway (it is the thing that will be making every subsequent call).
 *
 * Two probes, so a failure names its cause instead of collapsing to "couldn't connect":
 *   1. GET /health — unauthenticated and exempt from the daemon's auth gate. Answers "is something there, is it
 *      an intentic daemon, and can this browser talk to it" (DNS, TLS, and CORS all fail here).
 *   2. GET /environment — behind the daemon's global authorize() with no extra owner gate, so it answers "will
 *      it let ME in", and its 401/403 split is exactly the two things the user can act on. This request is also
 *      what performs the daemon's trust-on-first-use owner bind for a sandbox nobody has opened yet. */

// What a probe concluded. Every non-ok outcome maps to one thing the user can do next.
export type AttachOutcome =
    | { readonly kind: `ok` }
    // Nothing answered: wrong domain, sandbox down, or a daemon whose WEB_ORIGIN blocks this app via CORS.
    | { readonly kind: `unreachable` }
    // The daemon is up but refused the sign-in. Almost always an unclaimed sandbox started with a CONNECT_TOKEN
    // we don't hold — the daemon's 401 body is deliberately generic, so the token is what we offer.
    | { readonly kind: `needs-token` }
    // A verified identity the daemon won't accept: already owned by another account, or not an invited member.
    | { readonly kind: `denied`; readonly message: string }
    // Up, reachable, authorized-or-not — but answering something we can't interpret (a proxy error page, a
    // half-started daemon). Carries the status so the user can tell their proxy from their sandbox.
    | { readonly kind: `rejected`; readonly message: string };

// The daemon reports its failures as `{ error }` (hand-written routes) — fall back to the status when the body
// carries nothing useful, which is what a proxy sitting in front of a stopped sandbox typically returns.
const detailOf = async (response: Response, fallback: string): Promise<string> => {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    return body?.error ?? fallback;
};

export const probeDaemon = async (args: {
    readonly daemonUrl: string;
    readonly idToken: string;
    // The connection token to present for the daemon's first-bind gate: the platform row's token, or the one the
    // user pasted after a `needs-token`. Omitted when neither exists — a daemon started without CONNECT_TOKEN
    // binds the first verified identity with no token at all.
    readonly connectToken?: string;
}): Promise<AttachOutcome> => {
    const health = await fetch(`${args.daemonUrl}/health`).catch(() => undefined);
    if (health === undefined) {
        return { kind: `unreachable` };
    }
    if (!health.ok) {
        return { kind: `rejected`, message: await detailOf(health, `The address answered ${health.status} instead of a sandbox.`) };
    }
    const headers = new Headers({ authorization: `Bearer ${args.idToken}` });
    if (args.connectToken !== undefined && args.connectToken !== ``) {
        headers.set(`x-intentic-connect`, args.connectToken);
    }
    const authorized = await fetch(`${args.daemonUrl}/environment`, { headers }).catch(() => undefined);
    if (authorized === undefined) {
        return { kind: `unreachable` };
    }
    if (authorized.ok) {
        return { kind: `ok` };
    }
    if (authorized.status === 401) {
        return { kind: `needs-token` };
    }
    if (authorized.status === 403) {
        return { kind: `denied`, message: await detailOf(authorized, `This sandbox is registered to another account.`) };
    }
    return { kind: `rejected`, message: await detailOf(authorized, `The sandbox answered ${authorized.status}.`) };
};

// Turn whatever the user pasted into the base URL every daemon call is appended to, or undefined when it can't
// be one. Deliberately forgiving about the shape (a bare hostname, a full URL, a trailing slash, a copied
// address bar) and strict about the scheme — see daemonUrlProblem for why http:// gets its own answer.
export const normalizeDaemonUrl = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed === ``) {
        return undefined;
    }
    // A bare `sandbox.example.com` parses as a URL only once it has a scheme; https is the only one we accept,
    // so assuming it (rather than http) makes the common paste work with no scheme typed at all.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return undefined;
    }
    // A hostname with no dot and no port is a typo, not a domain (`localhost` included — an http-only origin
    // can't be reached from the HTTPS app anyway).
    if (url.protocol !== `https:` || !url.hostname.includes(`.`)) {
        return undefined;
    }
    // Keep a path prefix (a sandbox served under https://example.com/sandbox behind the user's own proxy), drop
    // the trailing slash so appended daemon paths don't produce `//health`, and drop query/hash entirely.
    return `${url.origin}${url.pathname.replace(/\/+$/, ``)}`;
};

// Why what the user typed can't be a sandbox address (undefined once it can) — inline field validation, so the
// two mistakes with real explanations don't fall into one silent "invalid" state.
export const daemonUrlProblem = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed === ``) {
        return undefined; // nothing typed yet is not yet a mistake
    }
    if (/^http:\/\//i.test(trimmed)) {
        return `Needs to be https — this app is served over HTTPS, so your browser would block calls to an http:// sandbox.`;
    }
    return normalizeDaemonUrl(trimmed) === undefined ? `That doesn't look like a domain — for example sandbox.example.com.` : undefined;
};

// A sensible sandbox name derived from its address, so the attach path asks for one paste and nothing else. The
// leftmost label is what distinguishes sandboxes on a shared zone (sandbox.example.com, dev.example.com); the
// field stays editable, this is only the default.
export const nameFromDaemonUrl = (daemonUrl: string): string => {
    const { hostname } = new URL(daemonUrl);
    return hostname.split(`.`)[0] ?? hostname;
};
