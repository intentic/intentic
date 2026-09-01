/* DOES THIS SANDBOX STILL EXIST, asked of the platform once per tunnel registration.
 *
 * A grant has no expiry on purpose (ingress-contract.ts): it sits in a container's env for the container's
 * whole life, and the revocation that matters is the sandbox row being deleted. Nothing about a signature can
 * express that, so the edge asks — and this call is the entire revocation mechanism.
 *
 * IT FAILS OPEN, and that is a decision rather than an oversight. The point of moving reachability off the
 * platform was that a sandbox stays reachable when the platform is down; a check that refused tunnels on a
 * failed lookup would hand that back, and worse, it would do it at exactly the moment things are already
 * broken — a platform outage would silently become a total outage as every container's backoff brought it
 * around to a refusal. Only a definite 404 refuses. Anything else — a timeout, a 500, a DNS failure, a
 * platform that was never configured — registers the tunnel and is retried on the next dial.
 *
 * ANSWERS ARE CACHED because a redial storm (an edge restart, a deploy) would otherwise ask the platform once
 * per container within a few seconds, which is the shape of a self-inflicted stampede. A failure is never
 * cached: fail-open is a decision to defer, and caching it would defer for the whole TTL.
 */

const REACHABILITY_PATH = `/api/reachability/`;

// Long enough to flatten a redial storm, short enough that deleting a sandbox takes effect on the timescale a
// person deleting one expects. Only ever consulted at register: a tunnel already up is not re-checked, so this
// is not how long a revoked sandbox stays reachable — closing the row's tunnel is (the daemon's own dial fails
// after that, because the container is gone with it).
const CACHE_TTL_MS = 60_000;

// The platform is not on the hot path and must not become a way to hang one. A lookup that has not answered
// in this long is treated as no answer at all, which fails open.
const TIMEOUT_MS = 5_000;

export interface RevocationOptions {
    // Empty ⇒ the check is off and every validly-signed grant registers.
    readonly platformUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly timeoutMs?: number;
    readonly log?: (message: string, error?: unknown) => void;
}

export interface Revocation {
    readonly allows: (sandboxId: string) => Promise<boolean>;
}

export const createRevocation = (options: RevocationOptions): Revocation => {
    const now = options.now ?? Date.now;
    const fetchImpl = options.fetchImpl ?? fetch;
    const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const base = options.platformUrl.replace(/\/$/, ``);
    const cache = new Map<string, { readonly exists: boolean; readonly at: number }>();

    if (base === ``) {
        return { allows: () => Promise.resolve(true) };
    }

    return {
        allows: async (sandboxId) => {
            const cached = cache.get(sandboxId);
            if (cached !== undefined && now() - cached.at < ttlMs) {
                return cached.exists;
            }
            try {
                const response = await fetchImpl(`${base}${REACHABILITY_PATH}${sandboxId}`, {
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (response.status === 404) {
                    cache.set(sandboxId, { exists: false, at: now() });
                    return false;
                }
                if (response.ok) {
                    cache.set(sandboxId, { exists: true, at: now() });
                    return true;
                }
                /* A 500 from the platform is not a statement about this sandbox, so it is not cached and not
                 * acted on. Registering is the fail-open branch. */
                options.log?.(`reachability lookup answered ${response.status}; registering anyway`);
                return true;
            } catch (error) {
                options.log?.(`reachability lookup failed; registering anyway`, error);
                return true;
            }
        },
    };
};
