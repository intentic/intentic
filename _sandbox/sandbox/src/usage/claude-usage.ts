import type { UsageWindow, WindowGates } from "@intentic/sandbox-contract";
import { type ClaudeStore, ensureFreshToken } from "../runtimes/claude/claude-credentials.js";
import type { HeadroomSource } from "./headroom.js";
import { asNumber, asRecord, asString, clampPercent, resetFromIso } from "./payload.js";

// Reader for native Claude accounts (translator-usage.ts's counterpart): reads the same OAuth endpoint claude.ai and
// Claude Code's /usage use, so numbers match. Not the SDK's usage-control request (null for an env token) or the
// stream's rate_limit_event (one window only); also read for idle accounts, since pools are account-wide.

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

// Two unscoped kinds map onto the shared window vocabulary (WINDOW_NAMES) and gate every model. A scoped entry is named
// by its scope: a per-model pool gates only that model, a surface-only pool gates nothing here.
const SHARED_KINDS: Record<string, string> = { session: "five_hour", weekly_all: "seven_day" };

// A scope's display name; accepts both a bare string and the object shape the endpoint sends today (see payload.ts).
const scopeName = (scope: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = scope?.[key];
    const named = asRecord(value);
    return asString(value) ?? asString(named?.[`display_name`] ?? named?.[`displayName`]);
};

interface PoolIdentity {
    readonly kind: string;
    readonly label?: string;
    readonly gates: WindowGates;
}

const poolIdentity = (limit: Record<string, unknown>): PoolIdentity => {
    const kind = asString(limit[`kind`]);
    const scope = asRecord(limit[`scope`]);
    const model = scopeName(scope, `model`);
    const surface = scopeName(scope, `surface`);
    if (model !== undefined) {
        return { kind: `model:${model}`, label: surface === undefined ? model : `${model} · ${surface}`, gates: { models: [model] } };
    }
    if (surface !== undefined) {
        return { kind: `surface:${surface}`, label: surface, gates: "none" };
    }
    const shared = kind === undefined ? undefined : SHARED_KINDS[kind];
    if (shared !== undefined) {
        return { kind: shared, gates: "all" };
    }
    // Unrecognised pool keeps its raw key rather than folding into a neighbour; unscoped, so it gates everything.
    return { kind: `claude:${kind ?? `unknown`}`, gates: "all" };
};

const appendWindow = (windows: UsageWindow[], identity: PoolIdentity, percent: number, resetsAt: number | undefined): void => {
    // First writer wins: two entries for one pool is a payload we don't understand, not a doubled reading.
    if (windows.some((window) => window.kind === identity.kind)) {
        return;
    }
    windows.push({
        ...identity,
        utilization: clampPercent(percent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
    });
};

// severity/is_active are dropped: which pool binds follows from percentages (bindingWindow), and severity bands are set
// once here, the same threshold for every provider.
const windowsFromLimits = (limits: unknown): UsageWindow[] => {
    const windows: UsageWindow[] = [];
    for (const entry of Array.isArray(limits) ? limits : []) {
        const limit = asRecord(entry);
        const percent = asNumber(limit?.[`percent`]);
        if (limit === undefined || percent === undefined) {
            continue;
        }
        appendWindow(windows, poolIdentity(limit), percent, resetFromIso(limit[`resets_at`] ?? limit[`resetsAt`]));
    }
    return windows;
};

// Fallback only when `limits` says nothing, never merged: the two spellings aren't matchable, so merging would
// double-count. extra_usage is excluded: a credit balance, not a plan pool, would skew who reads as spent.
const NOT_A_POOL = new Set([`extra_usage`]);

// What the flat keys gate: the two plan pools gate every model, the two published per-model keys gate their tier;
// everything else under a flat key is shown but binds nothing here.
const FLAT_GATES: Record<string, WindowGates> = {
    five_hour: "all",
    seven_day: "all",
    seven_day_opus: { models: ["opus"] },
    seven_day_sonnet: { models: ["sonnet"] },
};

const windowsFromPools = (body: Record<string, unknown>): UsageWindow[] => {
    const windows: UsageWindow[] = [];
    for (const [kind, value] of Object.entries(body)) {
        const reading = asRecord(value);
        const utilization = asNumber(reading?.[`utilization`]);
        if (reading === undefined || utilization === undefined || NOT_A_POOL.has(kind)) {
            continue;
        }
        appendWindow(windows, { kind, gates: FLAT_GATES[kind] ?? "none" }, utilization, resetFromIso(reading[`resets_at`] ?? reading[`resetsAt`]));
    }
    return windows;
};

export const claudeUsageWindows = (payload: unknown): UsageWindow[] => {
    const body = asRecord(payload);
    if (body === undefined) {
        return [];
    }
    const listed = windowsFromLimits(body[`limits`]);
    return listed.length > 0 ? listed : windowsFromPools(body);
};

export interface ClaudeUsageReading {
    readonly windows: UsageWindow[];
    // Endpoint's own stay-away on a 429, in ms; the one failure a caller must not treat as just "no reading".
    readonly retryAfterMs?: number;
}

// Best-effort: every failure reads as "no reading" (caller keeps the last one), except a 429, which carries the
// endpoint's own retry-after and is passed through for the sweep to honour.
export const readClaudeUsage = async (oauthToken: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<ClaudeUsageReading> => {
    try {
        const response = await fetchFn(USAGE_ENDPOINT, {
            headers: { Authorization: `Bearer ${oauthToken}`, "anthropic-beta": "oauth-2025-04-20" },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 429) {
            // retry-after is whole seconds; a malformed or absent header reads as a plain failure.
            const seconds = Number(response.headers.get("retry-after"));
            return { windows: [], ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}) };
        }
        if (!response.ok) {
            return { windows: [] };
        }
        return { windows: claudeUsageWindows((await response.json()) as unknown) };
    } catch {
        return { windows: [] };
    }
};

// Claude half of the headroom service: one target per connected account, reading the endpoint above on its own token.
// Since headroom is a fact about the account, not this sandbox's turns, the service polls idle accounts too.

// Shorter than a turn's read: a page may be waiting, so a slow endpoint costs freshness, not the answer.
const READ_TIMEOUT_MS = 8_000;

export const claudeHeadroomSource = (store: ClaudeStore, fetchFn: typeof fetch = fetch): HeadroomSource => ({
    targets: async () =>
        (await store.list())
            // Revoked credential can't read anything; asking would only mint a 401 per sweep.
            .filter((account) => account.needsReauth !== true)
            .map((account) => ({
                key: account.id,
                provider: "claude",
                read: async () => {
                    const token = await ensureFreshToken(store, account.id);
                    return token === undefined ? { windows: [] } : readClaudeUsage(token, fetchFn, READ_TIMEOUT_MS);
                },
            })),
});
