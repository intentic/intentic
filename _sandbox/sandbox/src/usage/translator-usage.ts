import { type AccountUsage, type KeyedProvider, reportsPlanLimits, type UsageWindow } from "@intentic/sandbox-contract";
import { asNumber, asRecord, asString, clampPercent, resetFromIso } from "./payload.js";

/* The READER for the routed subscriptions — the counterpart to claude-usage.ts, and the other half of what
 * fills account-usage.ts next door. Its whole job is to come back with an AccountUsage; where that snapshot is
 * then kept, merged or drawn is not its business.
 *
 * It has to pull where Claude's reader listens, because subscription quota is owned by CLIProxyAPI's auth files
 * rather than by anything in this daemon. The management API exposes exactly the door for it: a
 * credential-scoped HTTP proxy (`api-call`) that substitutes the chosen auth file's live access token
 * server-side, so quota is readable without a credential ever being downloaded here or handed to the browser.
 *
 * Every upstream shape is parsed defensively and both casings are accepted throughout: these are the providers'
 * private endpoints, not published contracts, and a field that changes name must cost a ring — never an
 * exception on the connection list. */

export interface TranslatorAuthFile {
    readonly name?: string;
    readonly provider?: string;
    readonly email?: string;
    readonly label?: string;
    readonly auth_index?: string;
    readonly project_id?: string;
    readonly id_token?: unknown;
}

interface ApiCallResult {
    readonly status_code?: number;
    readonly body?: string;
}

// Codex alone sends its resets as NUMBERS — an epoch instant or a relative offset — where the others send
// ISO-8601 (resetFromIso, payload.ts).
const resetSeconds = (absolute: unknown, relative: unknown, measuredAt: number): number | undefined => {
    const direct = asNumber(absolute);
    if (direct !== undefined) {
        // Upstream currently sends epoch seconds. Accept milliseconds too, so a payload change cannot put a
        // reset tens of thousands of years in the future.
        return Math.floor(direct > 10_000_000_000 ? direct / 1000 : direct);
    }
    const after = asNumber(relative);
    return after === undefined ? undefined : Math.floor(measuredAt / 1000 + after);
};

const codexWindowKind = (seconds: number | undefined, fallback: "primary" | "secondary"): "five_hour" | "seven_day" | "monthly" => {
    if (seconds === 18_000) {
        return "five_hour";
    }
    if (seconds !== undefined && seconds >= 28 * 24 * 60 * 60) {
        return "monthly";
    }
    if (seconds === 604_800) {
        return "seven_day";
    }
    // Old payloads omitted the duration and defined the two positions instead.
    return fallback === "primary" ? "five_hour" : "seven_day";
};

const codexWindowLabel = (group: string | undefined, kind: "five_hour" | "seven_day" | "monthly"): string | undefined => {
    if (group === undefined && kind !== "monthly") {
        // The shared UI already has precise names for the two ordinary Codex pools.
        return undefined;
    }
    const period = kind === "five_hour" ? "5-hour" : kind === "seven_day" ? "Weekly" : "Monthly";
    return group === undefined ? `${period} · all models` : `${group} · ${period}`;
};

const appendCodexLimit = (windows: UsageWindow[], value: unknown, measuredAt: number, group: string | undefined, keyPrefix: string): void => {
    const limit = asRecord(value);
    if (limit === undefined) {
        return;
    }
    const exhausted = limit[`limit_reached`] === true || limit[`limitReached`] === true || limit[`allowed`] === false;
    for (const position of ["primary", "secondary"] as const) {
        const reading = asRecord(limit[`${position}_window`] ?? limit[`${position}Window`]);
        if (reading === undefined) {
            continue;
        }
        const used = asNumber(reading[`used_percent`] ?? reading[`usedPercent`]) ?? (exhausted ? 100 : undefined);
        if (used === undefined) {
            continue;
        }
        const duration = asNumber(reading[`limit_window_seconds`] ?? reading[`limitWindowSeconds`]);
        const kind = codexWindowKind(duration, position);
        const label = codexWindowLabel(group, kind);
        const resetsAt = resetSeconds(
            reading[`reset_at`] ?? reading[`resetAt`],
            reading[`reset_after_seconds`] ?? reading[`resetAfterSeconds`],
            measuredAt,
        );
        windows.push({
            kind: group === undefined ? kind : `${keyPrefix}:${kind}`,
            ...(label === undefined ? {} : { label }),
            utilization: clampPercent(used),
            ...(resetsAt === undefined ? {} : { resetsAt }),
        });
    }
};

export const codexUsageFromPayload = (payload: unknown, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const body = asRecord(payload);
    if (body === undefined) {
        return undefined;
    }
    const windows: UsageWindow[] = [];
    appendCodexLimit(windows, body[`rate_limit`] ?? body[`rateLimit`], measuredAt, undefined, "codex");
    appendCodexLimit(windows, body[`code_review_rate_limit`] ?? body[`codeReviewRateLimit`], measuredAt, "Code review", "code-review");

    const additional = body[`additional_rate_limits`] ?? body[`additionalRateLimits`];
    if (Array.isArray(additional)) {
        for (const [index, item] of additional.entries()) {
            const entry = asRecord(item);
            if (entry === undefined) {
                continue;
            }
            const name =
                asString(entry[`limit_name`] ?? entry[`limitName`] ?? entry[`metered_feature`] ?? entry[`meteredFeature`]) ?? `Additional limit`;
            appendCodexLimit(windows, entry[`rate_limit`] ?? entry[`rateLimit`], measuredAt, name, `additional-${index + 1}`);
        }
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

export const geminiUsageFromPayload = (payload: unknown, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const body = asRecord(payload);
    const groups = body?.[`groups`];
    if (!Array.isArray(groups)) {
        return undefined;
    }
    const windows: UsageWindow[] = [];
    for (const [groupIndex, item] of groups.entries()) {
        const group = asRecord(item);
        if (group === undefined || !Array.isArray(group[`buckets`])) {
            continue;
        }
        const groupName = asString(group[`displayName`] ?? group[`display_name`]) ?? `Google quota ${groupIndex + 1}`;
        for (const [bucketIndex, bucketItem] of group[`buckets`].entries()) {
            const bucket = asRecord(bucketItem);
            if (bucket === undefined) {
                continue;
            }
            const remainingRaw = bucket[`remainingFraction`] ?? bucket[`remaining_fraction`];
            const remainingNumber = asNumber(remainingRaw);
            if (remainingNumber === undefined) {
                continue;
            }
            // A trailing-percent string is accepted defensively; the documented representation is a 0..1
            // fraction. AccountUsage stores UTILIZATION, hence the deliberate inversion.
            const remaining = typeof remainingRaw === "string" && remainingRaw.trim().endsWith("%") ? remainingNumber / 100 : remainingNumber;
            const bucketName = asString(bucket[`displayName`] ?? bucket[`display_name`]);
            const bucketId = asString(bucket[`bucketId`] ?? bucket[`bucket_id`]) ?? `${groupIndex + 1}-${bucketIndex + 1}`;
            const resetsAt = resetFromIso(bucket[`resetTime`] ?? bucket[`reset_time`]);
            windows.push({
                kind: `google:${bucketId}`,
                label: bucketName === undefined || bucketName === groupName ? groupName : `${groupName} · ${bucketName}`,
                utilization: clampPercent((1 - remaining) * 100),
                ...(resetsAt === undefined ? {} : { resetsAt }),
            });
        }
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

/* KIMI CODE, whose quota this sandbox spent a release reporting as unknowable. It is not: the Kimi Code
 * subscription's own OAuth token reads `/coding/v1/usages` directly, which is the same door the vendor's CLI
 * uses and needs nothing from CLIProxyAPI beyond the token substitution every reader here already gets.
 *
 * Two pools arrive under different keys and mean different things: `usage` is the PLAN's pool (a week, whose
 * exhaustion is the "billing cycle" 403), and each `limits[]` entry is a shorter throttle inside it — today a
 * single 5-hour window. Both are used/limit COUNTS, as decimal strings, so utilization is computed here rather
 * than read; a pool with no limit is dropped rather than divided by. */
const KIMI_UNIT_SECONDS: Record<string, number> = {
    TIME_UNIT_MINUTE: 60,
    TIME_UNIT_HOUR: 3_600,
    TIME_UNIT_DAY: 86_400,
    TIME_UNIT_WEEK: 604_800,
};

// The window's length in seconds, from the proto-style enum the platform sends it as. Undefined ⇒ a shape we
// don't recognise, which costs the pool its name below and nothing else.
const kimiWindowSeconds = (value: unknown): number | undefined => {
    const window = asRecord(value);
    const unit = KIMI_UNIT_SECONDS[asString(window?.[`timeUnit`]) ?? ``];
    const duration = asNumber(window?.[`duration`]);
    return unit === undefined || duration === undefined ? undefined : unit * duration;
};

/* A pool's identity on our wire. The two lengths every other subscription also has take the SHARED kinds, so a
 * Kimi meter sorts and reads beside a Claude one instead of inventing a second vocabulary for the same idea
 * (WINDOW_NAMES, usageStatus.ts). Anything else keeps its own namespaced kind and states its length, because a
 * throttle we cannot name is still a throttle worth drawing. */
const kimiWindowKind = (seconds: number | undefined): { kind: string; label?: string } => {
    if (seconds === 18_000) {
        return { kind: "five_hour" };
    }
    if (seconds === 604_800) {
        return { kind: "seven_day" };
    }
    if (seconds === undefined) {
        return { kind: "kimi:window", label: "Throttle" };
    }
    const [size, unit] =
        seconds % 86_400 === 0 ? [seconds / 86_400, "day"] : seconds % 3_600 === 0 ? [seconds / 3_600, "hour"] : [Math.round(seconds / 60), "minute"];
    return { kind: `kimi:${String(seconds)}s`, label: `${String(size)}-${unit} window` };
};

const appendKimiPool = (windows: UsageWindow[], value: unknown, seconds: number | undefined): void => {
    const pool = asRecord(value);
    const used = asNumber(pool?.[`used`]);
    const limit = asNumber(pool?.[`limit`]);
    // A limit of zero is not a spent pool, it is a pool the plan does not meter — dividing by it would report
    // every such account as permanently exhausted.
    if (used === undefined || limit === undefined || limit <= 0) {
        return;
    }
    const { kind, label } = kimiWindowKind(seconds);
    // First writer wins: the plan pool is appended before the throttles, so a `limits[]` entry that repeats the
    // same length cannot overwrite the pool the plan is actually sold by.
    if (windows.some((window) => window.kind === kind)) {
        return;
    }
    const resetsAt = resetFromIso(pool?.[`resetTime`]);
    windows.push({
        kind,
        ...(label === undefined ? {} : { label }),
        utilization: clampPercent((used / limit) * 100),
        ...(resetsAt === undefined ? {} : { resetsAt }),
    });
};

export const kimiUsageFromPayload = (payload: unknown, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const body = asRecord(payload);
    if (body === undefined) {
        return undefined;
    }
    const windows: UsageWindow[] = [];
    // The plan pool carries no window of its own — the platform leaves it implicit, and it is the weekly one the
    // subscription is sold by, which is also what the vendor's own client assumes when it synthesizes it.
    appendKimiPool(windows, body[`usage`], 604_800);
    for (const entry of Array.isArray(body[`limits`]) ? body[`limits`] : []) {
        const limit = asRecord(entry);
        appendKimiPool(windows, limit?.[`detail`], kimiWindowSeconds(limit?.[`window`]));
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

/* ---- which pool a routed model actually spends --------------------------------------------------------------
 *
 * Google is the whole reason this exists. Its Antigravity channel serves two model families off ONE sign-in and
 * meters them SEPARATELY: `retrieveUserQuotaSummary` answers with a "Gemini Models" group (Gemini Flash, Gemini
 * Pro) and a "Claude and GPT models" group (Claude Opus, Claude Sonnet, GPT-OSS), each carrying its own weekly
 * fraction and its own reset instant. An account is routinely spent for one and healthy for the other, and a
 * fleet of Google sign-ins settles into exactly that state.
 *
 * Reading an account's pools as one allowance is what put "resets Mon 9:41 PM" — the GEMINI pool's instant, on
 * an account that was not even serving the turn — under a refused Claude Opus turn, while a connected account
 * still held 27% of the pool that turn was actually spending.
 *
 * Codex and Kimi answer `undefined`, and that is not "unknown": their windows are LENGTHS of one undivided plan
 * (a 5-hour throttle inside a weekly pool) and every model spends all of them, so every window gates every turn.
 * A bucket id the provider has since renamed also matches nothing — which costs the caller its counts rather
 * than handing it the wrong pool, and a caller with no counts claims nothing about the fleet. */

export interface QuotaPool {
    // The recorded UsageWindow.kind this model's spend lands in.
    readonly kind: string;
    // How the provider names the group, as the subject of a sentence — Google's own wording, from the payload
    // above, because the pool a refusal names has to be the one the user reads on their Antigravity screen.
    readonly label: string;
}

const GOOGLE_GEMINI_POOL: QuotaPool = { kind: "google:gemini-weekly", label: "Gemini models" };
const GOOGLE_THIRD_PARTY_POOL: QuotaPool = { kind: "google:3p-weekly", label: "Claude and GPT models" };

export const quotaPoolFor = (provider: KeyedProvider, model: string): QuotaPool | undefined =>
    provider !== "gemini" ? undefined : model.startsWith("gemini") ? GOOGLE_GEMINI_POOL : GOOGLE_THIRD_PARTY_POOL;

/* WHAT THE RECORDED QUOTA SAYS ABOUT THAT POOL ACROSS EVERY CONNECTED ACCOUNT — the answer a refused routed
 * turn needs, and three facts rather than one instant.
 *
 * `withHeadroom` is the fact the old single-instant answer could not carry, and the one that changes what the
 * turn means: CLIProxyAPI balances across every auth file it holds, so a refusal is fleet-wide by construction.
 * If an account still has room in this pool then the quota is NOT what refused the turn — the translator had
 * every credential cooling for some other reason (a transient upstream error cools a credential for a minute),
 * and naming a weekly reset would send the user away for days over a condition that clears in seconds.
 *
 * Both counts zero ⇒ nothing on file measures this pool at all (never polled, or a renamed bucket), which is a
 * third state and reads as one: the caller says a limit was hit and claims nothing about the fleet. */
export interface TurnLimit {
    // Absent ⇒ the provider sells one undivided allowance, so there is no pool to name.
    readonly pool?: string;
    readonly spent: number;
    readonly withHeadroom: number;
    // When the earliest spent account reopens. Only ever set when nothing has headroom — with headroom on file
    // the pool is not the blocker, and there is no reset that answers "when can I send this again".
    readonly reopensAt?: number;
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const GOOGLE_USAGE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;

const apiCall = async (params: {
    readonly fetchFn: typeof fetch;
    readonly managementUrl: string;
    readonly managementToken: string;
    readonly authIndex: string;
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly header: Record<string, string>;
    readonly data?: string;
    readonly signal: AbortSignal;
}): Promise<unknown> => {
    const response = await params.fetchFn(`${params.managementUrl}/api-call`, {
        method: "POST",
        headers: { authorization: `Bearer ${params.managementToken}`, "content-type": "application/json" },
        body: JSON.stringify({
            auth_index: params.authIndex,
            method: params.method,
            url: params.url,
            header: params.header,
            ...(params.data === undefined ? {} : { data: params.data }),
        }),
        signal: params.signal,
    });
    if (!response.ok) {
        return undefined;
    }
    const result = (await response.json()) as ApiCallResult;
    if ((result.status_code ?? 0) < 200 || (result.status_code ?? 0) >= 300 || result.body === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(result.body) as unknown;
    } catch {
        return undefined;
    }
};

const codexAccountId = (file: TranslatorAuthFile): string | undefined => {
    const token = asRecord(file.id_token);
    const authInfo = asRecord(token?.[`https://api.openai.com/auth`]) ?? token;
    return asString(authInfo?.[`chatgpt_account_id`] ?? authInfo?.[`chatgptAccountId`]);
};

export const fetchTranslatorUsage = async (params: {
    readonly fetchFn: typeof fetch;
    readonly managementUrl: string;
    readonly managementToken: string;
    readonly provider: KeyedProvider;
    readonly file: TranslatorAuthFile;
}): Promise<AccountUsage | undefined> => {
    // A provider with no obtainable reading (reportsPlanLimits) never enters the refresh path — an unreadable
    // quota is not a failure to retry, and its rows stay dots on purpose.
    const authIndex = asString(params.file.auth_index);
    if (authIndex === undefined || !reportsPlanLimits(params.provider)) {
        return undefined;
    }
    const measuredAt = Date.now();
    const signal = AbortSignal.timeout(10_000);
    try {
        if (params.provider === "codex") {
            const accountId = codexAccountId(params.file);
            const payload = await apiCall({
                ...params,
                authIndex,
                url: CODEX_USAGE_URL,
                method: "GET",
                header: {
                    Authorization: "Bearer $TOKEN$",
                    "Content-Type": "application/json",
                    "User-Agent": "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal",
                    ...(accountId === undefined ? {} : { "Chatgpt-Account-Id": accountId }),
                },
                signal,
            });
            return codexUsageFromPayload(payload, measuredAt);
        }

        if (params.provider === "kimi") {
            const payload = await apiCall({
                ...params,
                authIndex,
                url: KIMI_USAGE_URL,
                method: "GET",
                header: { Authorization: "Bearer $TOKEN$", Accept: "application/json" },
                signal,
            });
            return kimiUsageFromPayload(payload, measuredAt);
        }

        const project = asString(params.file.project_id);
        if (project === undefined) {
            return undefined;
        }
        for (const url of GOOGLE_USAGE_URLS) {
            const payload = await apiCall({
                ...params,
                authIndex,
                url,
                method: "POST",
                header: {
                    Authorization: "Bearer $TOKEN$",
                    "Content-Type": "application/json",
                    "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
                },
                data: JSON.stringify({ project }),
                signal,
            });
            const usage = geminiUsageFromPayload(payload, measuredAt);
            if (usage !== undefined) {
                return usage;
            }
        }
    } catch {
        // Quota is an enhancement to the connection list, never a reason to hide the account itself.
    }
    return undefined;
};
