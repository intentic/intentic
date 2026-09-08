// One-step alternative to provision+run+wait: nothing is provisioned, so the browser itself verifies the pasted
// URL. Two probes name the failure: GET /health (unauthenticated: reachability) then GET /environment
// (authorized: also performs the daemon's first-use owner bind).

// Bounds the probe; without it a dead tunnel hangs on the browser's own multi-minute connect timeout.
const PROBE_TIMEOUT_MS = 10_000;

// Edge-up-but-nothing-behind statuses; Cloudflare's 530 usually means the container is gone.
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
    // Daemon refused the sign-in; almost always an unclaimed sandbox with a CONNECT_TOKEN we don't hold.
    | { readonly kind: `needs-token` }
    // A verified identity the daemon won't accept: already owned by another account, or not an invited member.
    | { readonly kind: `denied`; readonly message: string }
    // Reachable but answering something uninterpretable (proxy error page, half-started daemon); carries the status.
    | { readonly kind: `rejected`; readonly message: string };

// Daemon failures come as `{ error }`; falls back to the status text when the body has nothing useful, as a
// proxy in front of a stopped sandbox typically returns.
const detailOf = async (response: Response, fallback: string): Promise<string> => {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    return body?.error ?? fallback;
};

// One bounded probe. Distinguishes a refusal (DNS, TLS, connection, CORS: all indistinguishable, all mean
// nothing usable) from a hang, where something is listening but never answers.
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
    // Token for the daemon's first-bind gate; omitted, a tokenless daemon binds the first identity.
    readonly connectToken?: string;
}): Promise<AttachOutcome> => {
    const health = await probeFetch(`${args.daemonUrl}/health`);
    if (typeof health === `string`) {
        return { kind: health };
    }
    // Tunnel answering for a missing sandbox; a raw 530 would send the user chasing a DNS problem they don't have.
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

// Normalizes whatever the user pasted into the base URL for daemon calls, or undefined if it can't be one.
// Forgiving about shape (hostname, full URL, trailing slash); strict about scheme.
export const normalizeDaemonUrl = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed === ``) {
        return undefined;
    }
    // A bare hostname parses as a URL only with a scheme; assumes https so an unscheme pasted domain still works.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return undefined;
    }
    // A hostname with no dot is a typo, not a domain (`localhost` included); http can't reach this HTTPS app.
    if (url.protocol !== `https:` || !url.hostname.includes(`.`)) {
        return undefined;
    }
    // Keeps a path prefix (proxy-served sandbox), drops a trailing slash (avoids `//health`), drops query/hash.
    return `${url.origin}${url.pathname.replace(/\/+$/, ``)}`;
};

// Why what the user typed isn't a sandbox address yet (undefined once it is): keeps two explainable mistakes
// from collapsing into one silent "invalid".
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
