import { type AccountUsage, type KeyedProvider, reportsPlanLimits, type UsageWindow, type WindowGates, wordsOf } from "@intentic/sandbox-contract";
import { asNumber, asRecord, asString, clampPercent, resetFromIso } from "./payload.js";

// Reader for the routed subscriptions (counterpart to claude-usage.ts); returns an AccountUsage only, storage and
// merging live elsewhere.
// Pulls via the management API's `api-call`, a credential-scoped HTTP proxy that substitutes the auth file's access
// token server-side.
// Every upstream shape is parsed defensively in both casings; a changed field costs a ring, never an exception.

export interface TranslatorAuthFile {
    readonly name?: string;
    readonly provider?: string;
    readonly email?: string;
    readonly label?: string;
    readonly auth_index?: string;
    readonly project_id?: string;
    readonly id_token?: unknown;
    // The proxy's live verdict on this credential: `unavailable` is a transient bench (routed around until
    // `next_retry_after`), `disabled` is the operator's switch; neither is persisted on disk.
    readonly unavailable?: boolean;
    readonly disabled?: boolean;
    readonly status?: string;
    readonly status_message?: string;
    readonly next_retry_after?: string;
}

// Whether the proxy is currently routing around this file (TranslatorAccount.cooling); a bench with no retry instant is
// still a bench.
export const authFileCooling = (file: TranslatorAuthFile): { until?: number; reason?: string } | undefined => {
    if (file.unavailable !== true && file.disabled !== true) {
        return undefined;
    }
    const until = resetFromIso(file.next_retry_after);
    const reason = asString(file.status_message) ?? (file.disabled === true ? "disabled in the translator" : undefined);
    return { ...(until === undefined ? {} : { until }), ...(reason === undefined ? {} : { reason }) };
};

interface ApiCallResult {
    readonly status_code?: number;
    readonly body?: string;
}

// Codex sends resets as numbers (epoch instant or relative offset); other providers send ISO-8601 (resetFromIso,
// payload.ts).
const resetSeconds = (absolute: unknown, relative: unknown, measuredAt: number): number | undefined => {
    const direct = asNumber(absolute);
    if (direct !== undefined) {
        // Accepts milliseconds as well as epoch seconds, so a unit change cannot land a reset far in the future.
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
    // Missing duration falls back to the window's position, primary or secondary.
    return fallback === "primary" ? "five_hour" : "seven_day";
};

const codexWindowLabel = (group: string | undefined, kind: "five_hour" | "seven_day" | "monthly"): string | undefined => {
    if (group === undefined && kind !== "monthly") {
        // No label for the two ordinary pools; the UI already names them.
        return undefined;
    }
    const period = kind === "five_hour" ? "5-hour" : kind === "seven_day" ? "Weekly" : "Monthly";
    return group === undefined ? `${period} · all models` : `${group} · ${period}`;
};

// `rate_limit` is one undivided allowance every model spends. `code_review_rate_limit` and `additional_rate_limits` are
// named features shown but never binding.
const appendCodexLimit = (
    windows: UsageWindow[],
    value: unknown,
    measuredAt: number,
    group: string | undefined,
    keyPrefix: string,
    gates: WindowGates,
): void => {
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
            gates,
        });
    }
};

export const codexUsageFromPayload = (payload: unknown, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const body = asRecord(payload);
    if (body === undefined) {
        return undefined;
    }
    const windows: UsageWindow[] = [];
    appendCodexLimit(windows, body[`rate_limit`] ?? body[`rateLimit`], measuredAt, undefined, "codex", "all");
    appendCodexLimit(windows, body[`code_review_rate_limit`] ?? body[`codeReviewRateLimit`], measuredAt, "Code review", "code-review", "none");

    const additional = body[`additional_rate_limits`] ?? body[`additionalRateLimits`];
    if (Array.isArray(additional)) {
        for (const [index, item] of additional.entries()) {
            const entry = asRecord(item);
            if (entry === undefined) {
                continue;
            }
            const name =
                asString(entry[`limit_name`] ?? entry[`limitName`] ?? entry[`metered_feature`] ?? entry[`meteredFeature`]) ?? `Additional limit`;
            appendCodexLimit(windows, entry[`rate_limit`] ?? entry[`rateLimit`], measuredAt, name, `additional-${index + 1}`, "none");
        }
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

// Maps the app-server's `account/rateLimits/updated` snapshot (camelCase, minutes) onto the same windows a pulled
// reading uses.
export const codexUsageFromRateLimits = (payload: unknown, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const snapshot = asRecord(payload);
    if (snapshot === undefined) {
        return undefined;
    }
    const windows: UsageWindow[] = [];
    for (const position of ["primary", "secondary"] as const) {
        const reading = asRecord(snapshot[position]);
        const used = asNumber(reading?.[`usedPercent`] ?? reading?.[`used_percent`]);
        if (reading === undefined || used === undefined) {
            continue;
        }
        const minutes = asNumber(reading[`windowDurationMins`] ?? reading[`window_duration_mins`] ?? reading[`windowMinutes`]);
        const kind = codexWindowKind(minutes === undefined ? undefined : minutes * 60, position);
        const resetsAt = resetSeconds(reading[`resetsAt`] ?? reading[`resets_at`], undefined, measuredAt);
        windows.push({ kind, utilization: clampPercent(used), ...(resetsAt === undefined ? {} : { resetsAt }), gates: "all" });
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

// Gates come from words in the group/bucket names: `gemini` gates gemini only, `claude`/`gpt`/`3p`/etc gate the other
// family, and an unrecognized name gates everything rather than being ignored.
const GEMINI_WORDS = new Set(["gemini"]);
const THIRD_PARTY_WORDS = new Set(["claude", "gpt", "3p", "third", "party", "anthropic", "openai"]);
const googleGates = (...names: (string | undefined)[]): WindowGates => {
    const words = new Set(names.flatMap((name) => (name === undefined ? [] : wordsOf(name))));
    if ([...GEMINI_WORDS].some((word) => words.has(word))) {
        return { models: ["gemini"] };
    }
    if ([...THIRD_PARTY_WORDS].some((word) => words.has(word))) {
        return { models: ["claude", "gpt"] };
    }
    return "all";
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
            // A trailing `%` string is on a 0..100 scale; every other reading is a 0..1 fraction, normalized before the
            // utilization inversion.
            const remaining = typeof remainingRaw === "string" && remainingRaw.trim().endsWith("%") ? remainingNumber / 100 : remainingNumber;
            const bucketName = asString(bucket[`displayName`] ?? bucket[`display_name`]);
            const bucketId = asString(bucket[`bucketId`] ?? bucket[`bucket_id`]) ?? `${groupIndex + 1}-${bucketIndex + 1}`;
            const resetsAt = resetFromIso(bucket[`resetTime`] ?? bucket[`reset_time`]);
            windows.push({
                kind: `google:${bucketId}`,
                label: bucketName === undefined || bucketName === groupName ? groupName : `${groupName} · ${bucketName}`,
                utilization: clampPercent((1 - remaining) * 100),
                ...(resetsAt === undefined ? {} : { resetsAt }),
                gates: googleGates(groupName, bucketName, bucketId),
            });
        }
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

// Kimi Code's own OAuth token reads `/coding/v1/usages` directly, the same door the vendor's CLI uses. `usage` is the
// weekly plan pool; each `limits[]` entry is a shorter throttle inside it, both as decimal-string counts.
const KIMI_UNIT_SECONDS: Record<string, number> = {
    TIME_UNIT_MINUTE: 60,
    TIME_UNIT_HOUR: 3_600,
    TIME_UNIT_DAY: 86_400,
    TIME_UNIT_WEEK: 604_800,
};

// Window length in seconds from the platform's enum; an unrecognized shape only costs the pool its name below.
const kimiWindowSeconds = (value: unknown): number | undefined => {
    const window = asRecord(value);
    const unit = KIMI_UNIT_SECONDS[asString(window?.[`timeUnit`]) ?? ``];
    const duration = asNumber(window?.[`duration`]);
    return unit === undefined || duration === undefined ? undefined : unit * duration;
};

// 5-hour and 7-day map to the shared kinds (WINDOW_NAMES, usageStatus.ts) so a Kimi meter reads beside a Claude one.
// Anything else keeps a namespaced kind and states its length.
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
    // A zero limit means unmetered, not spent; dividing by it would read as permanently exhausted.
    if (used === undefined || limit === undefined || limit <= 0) {
        return;
    }
    const { kind, label } = kimiWindowKind(seconds);
    // First writer wins: the plan pool is appended before throttles, so a same-length `limits[]` entry cannot overwrite
    // it.
    if (windows.some((window) => window.kind === kind)) {
        return;
    }
    const resetsAt = resetFromIso(pool?.[`resetTime`]);
    // One undivided plan: the pool and every throttle inside it gate every model.
    windows.push({
        kind,
        ...(label === undefined ? {} : { label }),
        utilization: clampPercent((used / limit) * 100),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        gates: "all",
    });
};

export const kimiUsageFromPayload = (payload: unknown, measuredAt: number = Date.now()): AccountUsage | undefined => {
    const body = asRecord(payload);
    if (body === undefined) {
        return undefined;
    }
    const windows: UsageWindow[] = [];
    // The plan pool has no window in the payload; it is the weekly one the subscription is sold by.
    appendKimiPool(windows, body[`usage`], 604_800);
    for (const entry of Array.isArray(body[`limits`]) ? body[`limits`] : []) {
        const limit = asRecord(entry);
        appendKimiPool(windows, limit?.[`detail`], kimiWindowSeconds(limit?.[`window`]));
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

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
    // A provider `reportsPlanLimits` rejects never enters the refresh path; its rows stay dots, not a retry failure.
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
