import { type AccountUsage, type KeyedProvider, reportsPlanLimits, type UsageWindow } from "@intentic/sandbox-contract";

/* The READER for the routed subscriptions — the counterpart to claudeUsageWindows, and the other half of what
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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asNumber = (value: unknown): number | undefined => {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value.endsWith("%") ? value.slice(0, -1) : value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

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
            const resetRaw = asString(bucket[`resetTime`] ?? bucket[`reset_time`]);
            const resetMs = resetRaw === undefined ? Number.NaN : Date.parse(resetRaw);
            windows.push({
                kind: `google:${bucketId}`,
                label: bucketName === undefined || bucketName === groupName ? groupName : `${groupName} · ${bucketName}`,
                utilization: clampPercent((1 - remaining) * 100),
                ...(Number.isNaN(resetMs) ? {} : { resetsAt: Math.floor(resetMs / 1000) }),
            });
        }
    }
    return windows.length === 0 ? undefined : { windows, measuredAt };
};

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
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
