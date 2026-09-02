import type { UsageWindow, WindowGates } from "@intentic/sandbox-contract";
import { type ClaudeStore, ensureFreshToken } from "../claude/claude-credentials.js";
import type { HeadroomSource } from "./headroom.js";
import { asNumber, asRecord, asString, clampPercent, resetFromIso } from "./payload.js";

/* The READER for the native Claude accounts, the counterpart to translator-usage.ts next door, and the other
 * half of what fills account-usage.ts.
 *
 * It reads Anthropic's OAuth usage endpoint, which is the SAME door claude.ai's "Your usage limits" dialog and
 * Claude Code's own /usage go through: same pools, same percentages, same reset instants. So the numbers on the
 * Usage tab are not an estimate of the provider's numbers, they ARE the provider's numbers, and a reading that
 * disagrees with the one on claude.ai can only be a reading taken at a different moment.
 *
 * Deliberately NOT the SDK's usage control request: the CLI only reports rate limits for a profile it signed in
 * itself, and a daemon turn hands it a bare env token, so that read answers `rate_limits: null` every time. And
 * deliberately not the stream's rate_limit_event either, that names exactly ONE window (whichever the CLI
 * treated as binding for that request), which is how a Usage tab came to say "Weekly limit 1%" for an account
 * really sitting at 98% on its all-models weekly pool. All pools or none.
 *
 * TWO TRIGGERS, one reader. A Claude turn reads it at settle, at no token cost (agent.ts). The headroom
 * service reads it for accounts that are not running anything (claudeHeadroomSource, at the bottom of this
 * file), because these pools are ACCOUNT-wide: another Claude Code, the desktop app and claude.ai itself all
 * spend the same allowance without this sandbox hearing a word about it, so a reading is only ever as good as
 * it is recent. Before that existed the only reading was the turn's, and an idle sandbox's Usage tab showed a
 * floor ("≥87%") from whenever its last turn happened to end. */

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/* WHICH POOL A `limits[]` ENTRY IS, on our wire, and WHICH MODELS IT GATES.
 *
 * The two unscoped entries take the SHARED kinds every provider's reader maps onto (WINDOW_NAMES,
 * usageStatus.ts), so a Claude meter sorts and reads beside a Codex or Kimi one instead of inventing a second
 * vocabulary for the same idea. They gate every model: they are the plan's own allowance.
 *
 * A SCOPED entry is named by what it is scoped to. This is the whole reason the list is read at all: a plan's
 * per-model weekly allowance ("Fable", "Opus") arrives only here, the flat keys below carry `null` for it, so
 * reading the flat keys alone showed an account at 10% while its Fable pool sat at 82%. The name is the
 * provider's own display name, which is right for the same reason it is right everywhere else in this
 * directory: the models in a plan's limits are the provider's to rename, and the row has to match the screen
 * the user compares it against. It is ALSO the pool's gate: the plan names the tier by the vendor's word for
 * it, and that word is what the model id and label carry (plan-pools.ts), so a spent Opus slice binds an Opus
 * turn and leaves a Haiku call alone, which is the distinction that used to be lost.
 *
 * A pool scoped to a SURFACE alone ("Cowork") gates nothing here: it is another product's allowance on the same
 * plan, shown on the roster and never binding a turn this sandbox runs. */
const SHARED_KINDS: Record<string, string> = { session: "five_hour", weekly_all: "seven_day" };

// A scope's display name. Both spellings and both shapes (a bare string, or the object the endpoint sends
// today) are accepted, see payload.ts for why this file never trusts a shape.
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
    // A pool we can neither map nor name rides under its own raw key rather than being folded into a
    // neighbour: an unrecognised allowance is still an allowance, and one drawn as somebody else's is worse
    // than one drawn plainly (see UsageWindowSchema). Unscoped, so it is the plan's own and gates everything.
    return { kind: `claude:${kind ?? `unknown`}`, gates: "all" };
};

const appendWindow = (windows: UsageWindow[], identity: PoolIdentity, percent: number, resetsAt: number | undefined): void => {
    // First writer wins. Two entries for one pool is a payload we don't understand, and reporting the pool
    // twice would double it in every count that walks the windows.
    if (windows.some((window) => window.kind === identity.kind)) {
        return;
    }
    windows.push({
        ...identity,
        utilization: clampPercent(percent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
    });
};

// `severity` and `is_active` ride along on every entry and are deliberately dropped: which pool is binding
// follows from the percentages (bindingWindow), and the severity bands are ours to set, one threshold for
// every provider, or the colour on this screen means something different from the colour on the next.
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

/* THE SAME POOLS AS FLAT TOP-LEVEL KEYS, how the endpoint answered before `limits` existed, and how it still
 * answers alongside it. The FALLBACK, taken only when the list says nothing, and never merged into it: the two
 * spellings overlap without being matchable, because a per-model pool arrives here as a fixed key
 * (`seven_day_opus`) and there under a display name the plan is free to change, and nothing connects the two.
 * Merging would draw the same Opus allowance twice, once under each name.
 *
 * EVERY key that carries a reading, rather than the five this used to name by hand. The keys are the plan's to
 * add: `seven_day_cowork` appeared without notice, and a hand-written list is how a real allowance goes unseen
 * for a release. A key whose reading is `null` is a pool this plan does not meter, dropped, not shown at 0%,
 * which would read as "you have all of it left".
 *
 * `extra_usage` is excluded by name: it carries a `utilization` like a window but is a CREDIT BALANCE bought
 * beyond the plan, and folding it in would let purchased credits decide which account the picker calls
 * spent. */
const NOT_A_POOL = new Set([`extra_usage`]);

/* What the flat keys gate. The two plan pools gate every model; the two per-model keys the plan has published
 * by name gate their tier; everything else under a flat key (`seven_day_oauth_apps`, `seven_day_cowork`, a
 * codename pool) is a slice this sandbox's turns do not spend, shown and never binding. The `limits[]` form
 * above is the one that can name a codename pool's model; a flat key cannot, which is one more reason it is
 * the fallback. */
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
    // The endpoint's own stay-away on a 429, in ms. The one failure a caller must not shrug off as "no
    // reading": retrying inside this window is a guaranteed 429 and keeps the window alive.
    readonly retryAfterMs?: number;
}

/* Best-effort by construction, on both triggers: a usage read must never be able to fail, or stall, hence the
 * timeout, a turn that has already produced its answer, nor an account list that has an answer of its own.
 * Every failure reads as "no reading", which the caller turns into "keep the last one", except a rate limit,
 * which arrives with the endpoint's own answer to "when may I ask again" and is passed through for the sweep
 * to honour. */
export const readClaudeUsage = async (oauthToken: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<ClaudeUsageReading> => {
    try {
        const response = await fetchFn(USAGE_ENDPOINT, {
            headers: { Authorization: `Bearer ${oauthToken}`, "anthropic-beta": "oauth-2025-04-20" },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 429) {
            // Anthropic answers in whole seconds. A malformed or absent header reads as a plain failure,
            // the next sweep retries on its own cadence.
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

/* ---- keeping the readings current -------------------------------------------------------------------------
 *
 * The Claude half of the headroom service (usage/headroom.ts): one target per connected account, each reading
 * the endpoint above on the account's own token. What an account has left is a fact about the ACCOUNT, not
 * about this sandbox's turns, so a reading only taken when a turn ends describes whatever was true when that
 * turn ended; the service asks these targets whenever something happened, a screen opened or a plan refused,
 * and on a long idle floor for the accounts nobody is looking at, whose headroom still decides which one an
 * unattributed turn runs on (accountWithHeadroom). */

// Shorter than a turn's read: this one may have a page waiting behind it, and a slow endpoint must cost the
// list its freshness rather than its answer.
const READ_TIMEOUT_MS = 8_000;

export const claudeHeadroomSource = (store: ClaudeStore, fetchFn: typeof fetch = fetch): HeadroomSource => ({
    targets: async () =>
        (await store.list())
            // A revoked credential cannot read anything; asking would only mint a 401 per sweep.
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
