/* The "I already run my sandbox behind a domain that works" path of /setup, the one-step alternative to
 * provision-a-tunnel → run-a-command → wait-for-the-announce. Nothing is provisioned and nothing phones home,
 * so the BROWSER is what verifies the URL: the platform never calls into a sandbox, and "can this browser reach
 * it" is the only question that matters anyway (it is the thing that will be making every subsequent call).
 *
 * Two probes, so a failure names its cause instead of collapsing to "couldn't connect":
 *   1. GET /health, unauthenticated and exempt from the daemon's auth gate. Answers "is something there, is it
 *      an intentic daemon, and can this browser talk to it" (DNS, TLS, and CORS all fail here).
 *   2. GET /environment, behind the daemon's global authorize() with no extra owner gate, so it answers "will
 *      it let ME in", and its 401/403 split is exactly the two things the user can act on. This request is also
 *      what performs the daemon's trust-on-first-use owner bind for a sandbox nobody has opened yet. */

// How long a single probe request may hang before we call it. Without this the promise is bounded only by the
// browser's own connect timeout (minutes), which is exactly what a tunnel with no origin behind it produces,
// a spinner that never resolves. Generous enough for a cold sandbox on a slow link, short enough to answer.
const PROBE_TIMEOUT_MS = 10_000;

// Statuses a reverse proxy or tunnel edge returns when IT is up but the thing behind it is not. Cloudflare's
// 530 is the signature of a sandbox tunnel whose container is gone, which is the single most likely reason a
// resumed sandbox fails to attach. Worth telling apart from a daemon that answered something odd itself.
const NO_ORIGIN_STATUSES = new Set([502, 503, 504, 521, 522, 523, 530]);

// What a probe concluded. Every non-ok outcome maps to one thing the user can do next.
export type AttachOutcome =
    | { readonly kind: `ok` }
    // Nothing answered: wrong domain, sandbox down, or a daemon whose WEB_ORIGIN blocks this app via CORS.
    | { readonly kind: `unreachable` }
    // The address accepted the connection but never answered within PROBE_TIMEOUT_MS.
    | { readonly kind: `timeout` }
    // The domain resolves and its proxy/tunnel is up, but there is no sandbox running behind it.
    | { readonly kind: `no-origin`; readonly status: number }
    // The daemon is up but refused the sign-in. Almost always an unclaimed sandbox started with a CONNECT_TOKEN
    // we don't hold, the daemon's 401 body is deliberately generic, so the token is what we offer.
    | { readonly kind: `needs-token` }
    // A verified identity the daemon won't accept: already owned by another account, or not an invited member.
    | { readonly kind: `denied`; readonly message: string }
    // Up, reachable, authorized-or-not, but answering something we can't interpret (a proxy error page, a
    // half-started daemon). Carries the status so the user can tell their proxy from their sandbox.
    | { readonly kind: `rejected`; readonly message: string };

// The daemon reports its failures as `{ error }` (hand-written routes), fall back to the status when the body
// carries nothing useful, which is what a proxy sitting in front of a stopped sandbox typically returns.
const detailOf = async (response: Response, fallback: string): Promise<string> => {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    return body?.error ?? fallback;
};

// One probe request, bounded. Distinguishes the two failure modes the caller must word differently: a refusal
// (DNS miss, TLS failure, connection refused, CORS block, all indistinguishable to a browser, and all mean
// "nothing usable there") from a hang, which means something IS listening but never answers.
const probeFetch = async (url: string, init?: RequestInit): Promise<Response | `timeout` | `unreachable`> => {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (error) {
        return error instanceof DOMException && error.name === `TimeoutError` ? `timeout` : `unreachable`;
    }
};

export const probeDaemon = async (args: {
    readonly daemonUrl: string;
    readonly idToken: string;
    // The connection token to present for the daemon's first-bind gate: the platform row's token, or the one the
    // user pasted after a `needs-token`. Omitted when neither exists, a daemon started without CONNECT_TOKEN
    // binds the first verified identity with no token at all.
    readonly connectToken?: string;
}): Promise<AttachOutcome> => {
    const health = await probeFetch(`${args.daemonUrl}/health`);
    if (typeof health === `string`) {
        return { kind: health };
    }
    // A tunnel or proxy answering for a sandbox that isn't there, the resumed-sandbox case, and the one where
    // "the address answered 530" would send the user hunting for a DNS problem they don't have.
    if (NO_ORIGIN_STATUSES.has(health.status)) {
        return { kind: `no-origin`, status: health.status };
    }
    if (!health.ok) {
        return { kind: `rejected`, message: await detailOf(health, `The address answered ${health.status} instead of a sandbox.`) };
    }
    const headers = new Headers({ authorization: `Bearer ${args.idToken}` });
    if (args.connectToken !== undefined && args.connectToken !== ``) {
        headers.set(`x-intentic-connect`, args.connectToken);
    }
    const authorized = await probeFetch(`${args.daemonUrl}/environment`, { headers });
    if (typeof authorized === `string`) {
        return { kind: authorized };
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
// address bar) and strict about the scheme, see daemonUrlProblem for why http:// gets its own answer.
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
    // A hostname with no dot and no port is a typo, not a domain (`localhost` included, an http-only origin
    // can't be reached from the HTTPS app anyway).
    if (url.protocol !== `https:` || !url.hostname.includes(`.`)) {
        return undefined;
    }
    // Keep a path prefix (a sandbox served under https://example.com/sandbox behind the user's own proxy), drop
    // the trailing slash so appended daemon paths don't produce `//health`, and drop query/hash entirely.
    return `${url.origin}${url.pathname.replace(/\/+$/, ``)}`;
};

// Why what the user typed can't be a sandbox address (undefined once it can), inline field validation, so the
// two mistakes with real explanations don't fall into one silent "invalid" state.
export const daemonUrlProblem = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed === ``) {
        return undefined; // nothing typed yet is not yet a mistake
    }
    if (/^http:\/\//i.test(trimmed)) {
        return `Needs to be https. This app is served over HTTPS, so your browser would block calls to an http:// sandbox.`;
    }
    return normalizeDaemonUrl(trimmed) === undefined ? `That doesn't look like a domain. For example sandbox.example.com.` : undefined;
};
