// Asks the platform whether a sandbox exists and how it's reached, and caches the answer; `allows` is the registration
// gate, `lookup` the full answer used for replay decisions.
// Fails open: only a definite 404 refuses; a timeout, 500, DNS failure or unconfigured platform registers or exists
// instead.
// Answers are cached for the TTL; a failure never is, since fail-open must not defer for the whole window.

const REACHABILITY_PATH = `/api/reachability/`;

// Flattens a redial storm without much revocation delay; consulted only at register and on a local miss.
const CACHE_TTL_MS = 60_000;

// Platform isn't on the hot path and must not hang it; no answer in this long is treated as fail-open.
const TIMEOUT_MS = 5_000;

// Which fabric reaches a sandbox: `hosted` replays to a Fly app, `tunnel` dials the edge; undefined if the platform
// didn't say.
export type Lane = "hosted" | "tunnel";

export interface Reachability {
    readonly exists: boolean;
    readonly lane?: Lane;
    // Fly app to replay to, when the platform names it; server.ts derives one from the id otherwise.
    readonly app?: string;
}

export interface RevocationOptions {
    // Empty disables the check: every signed grant registers, and every id exists on an unknown lane.
    readonly platformUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly timeoutMs?: number;
    readonly log?: (message: string, error?: unknown) => void;
}

export interface Revocation {
    // Registration gate: may a tunnel presenting a grant for this id be held?
    readonly allows: (sandboxId: string) => Promise<boolean>;
    // Full answer, for a request no tunnel holds.
    readonly lookup: (sandboxId: string) => Promise<Reachability>;
}

// Reads the platform's answer leniently: no lane named is an older platform; an unnamed lane still exists.
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
            // A 500 isn't a statement about this sandbox: not cached, not acted on; treated as exists on an unknown
            // lane.
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
