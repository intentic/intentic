/* DOES THIS SANDBOX STILL EXIST, AND HOW IS IT REACHED, asked of the platform and cached.
 *
 * Two callers, one question. A tunnel registering presents a grant that has no expiry on purpose
 * (ingress-contract.ts): it sits in a container's env for the container's whole life, and the revocation that
 * matters is the sandbox row being deleted. Nothing about a signature can express that, so the edge asks —
 * and `allows` is the entire revocation mechanism. A request for a hostname NO tunnel holds asks the same
 * thing for a different reason: a sandbox the platform runs on Fly is reached by replaying the request to its
 * app (server.ts), while a sandbox on somebody's own machine is reached only through the tunnel it dials, so
 * the lane decides whether a missing tunnel is "replay it" or "not connected". `lookup` is the whole answer;
 * `allows` is the half a registration needs.
 *
 * IT FAILS OPEN, and that is a decision rather than an oversight. The point of moving reachability off the
 * platform was that a sandbox stays reachable when the platform is down; a check that refused tunnels on a
 * failed lookup would hand that back, and worse, it would do it at exactly the moment things are already
 * broken — a platform outage would silently become a total outage as every container's backoff brought it
 * around to a refusal. Only a definite 404 refuses. Anything else — a timeout, a 500, a DNS failure, a
 * platform that was never configured — registers the tunnel and is retried on the next dial. The same rule
 * for the lane: a platform that cannot say which lane an id is on answers "exists, lane unknown", and the
 * edge replays rather than refuses, because a wrong replay costs one proxy error and a wrong refusal costs a
 * working sandbox.
 *
 * ANSWERS ARE CACHED because a redial storm (an edge restart, a deploy) would otherwise ask the platform once
 * per container within a few seconds, which is the shape of a self-inflicted stampede — and because with the
 * replay path the edge is asked once per hostname per replay-cache TTL, which is the same storm in slow
 * motion. A failure is never cached: fail-open is a decision to defer, and caching it would defer for the
 * whole TTL.
 */

const REACHABILITY_PATH = `/api/reachability/`;

// Long enough to flatten a redial storm, short enough that deleting a sandbox takes effect on the timescale a
// person deleting one expects. Only ever consulted at register and on a local miss: a tunnel already up is not
// re-checked, so this is not how long a revoked sandbox stays reachable — closing the row's tunnel is (the
// daemon's own dial fails after that, because the container is gone with it).
const CACHE_TTL_MS = 60_000;

// The platform is not on the hot path and must not become a way to hang one. A lookup that has not answered
// in this long is treated as no answer at all, which fails open.
const TIMEOUT_MS = 5_000;

// Which fabric reaches a sandbox: `hosted` is a Fly app the platform runs (replay to it), `tunnel` is a box
// that dials the edge (nothing to replay to). Undefined when the platform could not say.
export type Lane = "hosted" | "tunnel";

export interface Reachability {
    readonly exists: boolean;
    readonly lane?: Lane;
    // The Fly app to replay to, when the platform names it. server.ts derives one from the id otherwise.
    readonly app?: string;
}

export interface RevocationOptions {
    // Empty ⇒ the check is off: every validly-signed grant registers, and every id exists on an unknown lane.
    readonly platformUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly timeoutMs?: number;
    readonly log?: (message: string, error?: unknown) => void;
}

export interface Revocation {
    // The registration gate: may a tunnel presenting a grant for this id be held?
    readonly allows: (sandboxId: string) => Promise<boolean>;
    // The whole answer, for a request no tunnel holds.
    readonly lookup: (sandboxId: string) => Promise<Reachability>;
}

// What the platform says about a sandbox, read leniently: a body that names no lane is an older platform, and
// an id that exists on a lane it will not name is still an id that exists.
const parseAnswer = (body: unknown): Reachability => {
    const record = typeof body === `object` && body !== null ? (body as { lane?: unknown; app?: unknown }) : {};
    const lane = record.lane === `hosted` || record.lane === `tunnel` ? record.lane : undefined;
    const app = typeof record.app === `string` && record.app !== `` ? record.app : undefined;
    return { exists: true, ...(lane === undefined ? {} : { lane }), ...(app === undefined ? {} : { app }) };
};

const UNKNOWN: Reachability = { exists: true };

export const createRevocation = (options: RevocationOptions): Revocation => {
    const now = options.now ?? Date.now;
    const fetchImpl = options.fetchImpl ?? fetch;
    const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const base = options.platformUrl.replace(/\/$/, ``);
    const cache = new Map<string, { readonly answer: Reachability; readonly at: number }>();

    const lookup = async (sandboxId: string): Promise<Reachability> => {
        if (base === ``) {
            return UNKNOWN;
        }
        const cached = cache.get(sandboxId);
        if (cached !== undefined && now() - cached.at < ttlMs) {
            return cached.answer;
        }
        try {
            const response = await fetchImpl(`${base}${REACHABILITY_PATH}${sandboxId}`, {
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (response.status === 404) {
                const answer: Reachability = { exists: false };
                cache.set(sandboxId, { answer, at: now() });
                return answer;
            }
            if (response.ok) {
                const answer = parseAnswer(await response.json().catch(() => undefined));
                cache.set(sandboxId, { answer, at: now() });
                return answer;
            }
            /* A 500 from the platform is not a statement about this sandbox, so it is not cached and not
             * acted on. "Exists, lane unknown" is the fail-open branch. */
            options.log?.(`reachability lookup answered ${response.status}; assuming the sandbox exists`);
            return UNKNOWN;
        } catch (error) {
            options.log?.(`reachability lookup failed; assuming the sandbox exists`, error);
            return UNKNOWN;
        }
    };

    return {
        lookup,
        allows: async (sandboxId) => (await lookup(sandboxId)).exists,
    };
};
