import type { UsageWindow } from "@intentic/sandbox-contract";
import { type ClaudeStore, ensureFreshToken } from "../claude/claude-credentials.js";
import type { AccountUsageStore } from "./account-usage.js";
import { asNumber, asRecord, asString, clampPercent, resetFromIso } from "./payload.js";

/* The READER for the native Claude accounts — the counterpart to translator-usage.ts next door, and the other
 * half of what fills account-usage.ts.
 *
 * It reads Anthropic's OAuth usage endpoint, which is the SAME door claude.ai's "Your usage limits" dialog and
 * Claude Code's own /usage go through: same pools, same percentages, same reset instants. So the numbers on the
 * Usage tab are not an estimate of the provider's numbers, they ARE the provider's numbers — and a reading that
 * disagrees with the one on claude.ai can only be a reading taken at a different moment.
 *
 * Deliberately NOT the SDK's usage control request: the CLI only reports rate limits for a profile it signed in
 * itself, and a daemon turn hands it a bare env token, so that read answers `rate_limits: null` every time. And
 * deliberately not the stream's rate_limit_event either — that names exactly ONE window (whichever the CLI
 * treated as binding for that request), which is how a Usage tab came to say "Weekly limit 1%" for an account
 * really sitting at 98% on its all-models weekly pool. All pools or none.
 *
 * TWO TRIGGERS, one reader. A Claude turn reads it at settle, at no token cost (agent.ts). The refresher at the
 * bottom of this file reads it for accounts that are not running anything, because these pools are ACCOUNT-wide:
 * another Claude Code, the desktop app and claude.ai itself all spend the same allowance without this sandbox
 * hearing a word about it, so a reading is only ever as good as it is recent. Before the refresher existed the
 * only reading was the turn's, and an idle sandbox's Usage tab showed a floor ("≥87%") from whenever its last
 * turn happened to end. */

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/* WHICH POOL A `limits[]` ENTRY IS, on our wire.
 *
 * The two unscoped entries take the SHARED kinds every provider's reader maps onto (WINDOW_NAMES,
 * usageStatus.ts), so a Claude meter sorts and reads beside a Codex or Kimi one instead of inventing a second
 * vocabulary for the same idea.
 *
 * A SCOPED entry is named by what it is scoped to. This is the whole reason the list is read at all: a plan's
 * per-model weekly allowance ("Fable", "Opus") arrives only here — the flat keys below carry `null` for it — so
 * reading the flat keys alone showed an account at 10% while its Fable pool sat at 82%. The name is the
 * provider's own display name, which is right for the same reason it is right everywhere else in this
 * directory: the models in a plan's limits are the provider's to rename, and the row has to match the screen
 * the user compares it against. */
const SHARED_KINDS: Record<string, string> = { session: "five_hour", weekly_all: "seven_day" };

// A scope's display name. Both spellings and both shapes (a bare string, or the object the endpoint sends
// today) are accepted — see payload.ts for why this file never trusts a shape.
const scopeName = (scope: Record<string, unknown> | undefined, key: string): string | undefined => {
    const value = scope?.[key];
    const named = asRecord(value);
    return asString(value) ?? asString(named?.[`display_name`] ?? named?.[`displayName`]);
};

const poolIdentity = (limit: Record<string, unknown>): { kind: string; label?: string } => {
    const kind = asString(limit[`kind`]);
    const scope = asRecord(limit[`scope`]);
    const model = scopeName(scope, `model`);
    const surface = scopeName(scope, `surface`);
    if (model !== undefined) {
        return { kind: `model:${model}`, label: surface === undefined ? model : `${model} · ${surface}` };
    }
    if (surface !== undefined) {
        return { kind: `surface:${surface}`, label: surface };
    }
    const shared = kind === undefined ? undefined : SHARED_KINDS[kind];
    if (shared !== undefined) {
        return { kind: shared };
    }
    // A pool we can neither map nor name rides under its own raw key rather than being folded into a
    // neighbour: an unrecognised allowance is still an allowance, and one drawn as somebody else's is worse
    // than one drawn plainly (see UsageWindowSchema).
    return { kind: `claude:${kind ?? `unknown`}` };
};

const appendWindow = (windows: UsageWindow[], identity: { kind: string; label?: string }, percent: number, resetsAt: number | undefined): void => {
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
// follows from the percentages (bindingWindow), and the severity bands are ours to set — one threshold for
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

/* THE SAME POOLS AS FLAT TOP-LEVEL KEYS — how the endpoint answered before `limits` existed, and how it still
 * answers alongside it. The FALLBACK, taken only when the list says nothing, and never merged into it: the two
 * spellings overlap without being matchable, because a per-model pool arrives here as a fixed key
 * (`seven_day_opus`) and there under a display name the plan is free to change, and nothing connects the two.
 * Merging would draw the same Opus allowance twice, once under each name.
 *
 * EVERY key that carries a reading, rather than the five this used to name by hand. The keys are the plan's to
 * add: `seven_day_cowork` appeared without notice, and a hand-written list is how a real allowance goes unseen
 * for a release. A key whose reading is `null` is a pool this plan does not meter — dropped, not shown at 0%,
 * which would read as "you have all of it left".
 *
 * `extra_usage` is excluded by name: it carries a `utilization` like a window but is a CREDIT BALANCE bought
 * beyond the plan, and folding it in would let purchased credits decide which account the picker calls
 * spent. */
const NOT_A_POOL = new Set([`extra_usage`]);

const windowsFromPools = (body: Record<string, unknown>): UsageWindow[] => {
    const windows: UsageWindow[] = [];
    for (const [kind, value] of Object.entries(body)) {
        const reading = asRecord(value);
        const utilization = asNumber(reading?.[`utilization`]);
        if (reading === undefined || utilization === undefined || NOT_A_POOL.has(kind)) {
            continue;
        }
        appendWindow(windows, { kind }, utilization, resetFromIso(reading[`resets_at`] ?? reading[`resetsAt`]));
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

/* Best-effort by construction, on both triggers: a usage read must never be able to fail — or stall, hence the
 * timeout — a turn that has already produced its answer, nor an account list that has an answer of its own.
 * Every failure reads as "no reading", which the caller turns into "keep the last one". */
export const readClaudeUsage = async (oauthToken: string, fetchFn: typeof fetch, timeoutMs = 10_000): Promise<UsageWindow[]> => {
    const payload = await fetchFn(USAGE_ENDPOINT, {
        headers: { Authorization: `Bearer ${oauthToken}`, "anthropic-beta": "oauth-2025-04-20" },
        signal: AbortSignal.timeout(timeoutMs),
    })
        .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
        .catch(() => undefined);
    return payload === undefined ? [] : claudeUsageWindows(payload);
};

/* ---- keeping the readings current -------------------------------------------------------------------------
 *
 * The sweep that makes a Claude row as trustworthy as the provider's own screen. It is the native counterpart
 * to the translator client's refreshUsage, and it exists for the same reason: what an account has left is a
 * fact about the ACCOUNT, not about this sandbox's turns, so a reading only taken when a turn ends describes
 * whatever was true when that turn ended.
 *
 * The reads are free — no tokens, one HTTPS round-trip per account — which is what makes waiting for them
 * affordable where the routed sweep can only schedule them. `/claude/accounts` awaits this within a deadline,
 * so opening the Usage tab produces the same numbers as opening the dialog on claude.ai; the timer covers the
 * accounts nobody is looking at, whose headroom still decides which one an unattributed turn runs on
 * (accountWithHeadroom). */

// Under this, a reading is current enough that another round-trip would tell us nothing new — pools move with
// spend, not with the clock. Comfortably inside the ten minutes past which a reading is shown as a floor.
const FRESH_MS = 60_000;
// The idle cadence. Same five minutes the routed sweep and the token rotation run on: often enough that no
// reading is ever old enough to be marked a floor, rare enough to be invisible.
const SWEEP_MS = 5 * 60_000;
// Shorter than a turn's read: this one has a page waiting behind it, and a slow endpoint must cost the list
// its freshness rather than its answer.
const READ_TIMEOUT_MS = 8_000;

export interface ClaudeUsageRefresher {
    // Bring every connected account's reading up to date, skipping the ones already current. Resolves when the
    // sweep lands or at `withinMs`, whichever comes first — a caller that gave up waiting still gets the
    // reading on its next read, because the sweep it started keeps running.
    readonly refresh: (withinMs?: number) => Promise<void>;
    // Sweep now and every `intervalMs` after. Returns the stop.
    readonly start: (intervalMs?: number) => () => void;
}

const deadline = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        // Unref'd: a list that stopped waiting must not hold the process open until its deadline.
        setTimeout(resolve, ms).unref();
    });

export const createClaudeUsageRefresher = (deps: {
    readonly store: ClaudeStore;
    readonly usage: AccountUsageStore;
    readonly fetchFn?: typeof fetch;
}): ClaudeUsageRefresher => {
    const fetchFn = deps.fetchFn ?? fetch;
    /* When each account was last ASKED, not what it answered — the same bound the routed sweep keeps. The store
     * caches the successes; this is what stops an endpoint that is down (or an account whose plan reports
     * nothing) from being retried on every single account list. */
    const attemptedAt = new Map<string, number>();
    // The sweep in flight, so a page load that arrives during one joins it instead of starting a second.
    let sweeping: Promise<void> | undefined;

    const readOne = async (id: string): Promise<void> => {
        attemptedAt.set(id, Date.now());
        const token = await ensureFreshToken(deps.store, id);
        if (token === undefined) {
            return;
        }
        const windows = await readClaudeUsage(token, fetchFn, READ_TIMEOUT_MS);
        // A read that failed or found no pool at all leaves the last good snapshot standing: an empty window
        // list would read as "measured, and this account has no limits" — the opposite of what happened.
        if (windows.length > 0) {
            await deps.usage.record(id, { windows, measuredAt: Date.now() });
        }
    };

    const sweep = async (): Promise<void> => {
        const [accounts, stored] = await Promise.all([deps.store.list(), deps.usage.read()]);
        const now = Date.now();
        const due = accounts.filter(
            (account) =>
                // A revoked credential cannot read anything; asking would only mint a 401 per sweep.
                account.needsReauth !== true && Math.max(stored[account.id]?.measuredAt ?? 0, attemptedAt.get(account.id) ?? 0) < now - FRESH_MS,
        );
        // A sandbox holds a handful of Claude accounts (the fleets are on the routed providers, which bound
        // their own concurrency for exactly that reason), so the whole sweep goes out at once.
        await Promise.all(
            due.map((account) =>
                readOne(account.id).catch((error: unknown) =>
                    deps.store.logger.warn({ err: error, account: account.id }, "claude usage read failed — the next sweep retries"),
                ),
            ),
        );
    };

    const refresh = (withinMs?: number): Promise<void> => {
        // Never rejects: an account list must not fail because a quota read did — the rings are an enhancement
        // to that list, exactly as they are to the routed one.
        sweeping ??= sweep()
            .catch((error: unknown) => deps.store.logger.warn({ err: error }, "claude usage sweep failed — the next one retries"))
            .finally(() => {
                sweeping = undefined;
            });
        return withinMs === undefined ? sweeping : Promise.race([sweeping, deadline(withinMs)]);
    };

    return {
        refresh,
        start: (intervalMs = SWEEP_MS) => {
            const timer = setInterval(() => void refresh(), intervalMs);
            // The daemon's other loops do the same: a background refresh must never hold the process open.
            timer.unref();
            void refresh();
            return () => clearInterval(timer);
        },
    };
};
