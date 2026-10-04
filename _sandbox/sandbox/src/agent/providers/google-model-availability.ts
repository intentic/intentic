import { z } from "zod";

/** Exact model IDs shared by every enabled Google account successfully read from the live translator. */
export type GoogleModelAvailability =
    | { readonly state: "verified"; readonly accounts: number; readonly models: readonly string[] }
    | { readonly state: "incomplete"; readonly accounts: number; readonly verified: number; readonly models: readonly string[] }
    | { readonly state: "unknown" };

interface Deadline {
    readonly signal: AbortSignal;
    readonly dispose: () => void;
}

interface GoogleAccount {
    readonly authIndex: string | undefined;
    readonly project: string | undefined;
}

interface Inventory {
    readonly fingerprint: string;
    readonly accounts: readonly GoogleAccount[];
}

const CACHE_TTL_MS = 60_000;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const SWEEP_TIMEOUT_MS = 15_000;
const MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
// The metadata convention already used by translator-usage.ts; the proxy substitutes $TOKEN$ server-side.
const GOOGLE_USER_AGENT = "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)";

const deadlineAfter = (ms: number): Deadline => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
};

// Validate without trimming: model IDs, project IDs and auth handles must be sent and compared literally.
const LiteralIdSchema = z.string().refine((value) => value.trim() !== "");
const ReadableHandleSchema = LiteralIdSchema.optional().catch(undefined);

// Unparsed identity fields remain only inside this boundary so malformed handles/projects still fingerprint distinctly.
const AuthFileSchema = z.object({
    provider: LiteralIdSchema,
    id: z.unknown().optional(),
    name: z.unknown().optional(),
    email: z.unknown().optional(),
    path: z.unknown().optional(),
    auth_index: z.unknown().optional(),
    project_id: z.unknown().optional(),
    disabled: z.unknown().optional(),
    created_at: z.unknown().optional(),
    updated_at: z.unknown().optional(),
    modtime: z.unknown().optional(),
    last_refresh: z.unknown().optional(),
});

// An unidentifiable row could be another Google account; it cannot prove an empty routing inventory.
const InventorySchema = z.object({ files: z.array(AuthFileSchema) }).transform((payload): Inventory => {
    const accounts: GoogleAccount[] = [];
    const fingerprints: string[] = [];
    for (const file of payload.files) {
        if (file.provider !== "antigravity") {
            continue;
        }
        // Include disabled rows and credential identity/reconnection stamps, not temporary routing verdicts.
        // updated_at may also change on a cooldown: an extra read is safe, excluding that account is not.
        fingerprints.push(
            JSON.stringify([
                file.id,
                file.name,
                file.email,
                file.path,
                file.auth_index,
                file.project_id,
                file.disabled === true,
                file.created_at,
                file.updated_at,
                file.modtime,
                file.last_refresh,
            ]),
        );
        if (file.disabled !== true) {
            accounts.push({ authIndex: ReadableHandleSchema.parse(file.auth_index), project: ReadableHandleSchema.parse(file.project_id) });
        }
    }
    return { fingerprint: JSON.stringify(fingerprints.sort()), accounts };
});

const ArrayModelIdSchema = z
    .record(z.string(), z.unknown())
    .transform((entry) => {
        const field = ["id", "name", "modelId"].find((key) => Object.hasOwn(entry, key));
        return field === undefined ? undefined : entry[field];
    })
    .pipe(LiteralIdSchema);

// Every entry must parse: dropping an unreadable entry would turn unknown entitlement into a proven negative.
const ModelIdsSchema = z
    .object({
        models: z.union([
            z.record(LiteralIdSchema, z.record(z.string(), z.unknown())).transform((entries) => Object.keys(entries)),
            z.array(ArrayModelIdSchema),
        ]),
    })
    .transform((payload) => [...new Set(payload.models)].sort());

const ApiCallSchema = z.object({ status_code: z.number().int().min(200).max(299), body: z.string() });

/** A single reader instance shares the entire inventory-and-metadata execution across concurrent callers. */
export const createGoogleModelAvailabilityReader = (params: {
    readonly managementUrl: string;
    readonly token: string;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
    readonly requestTimeoutMs?: number;
    readonly sweepTimeoutMs?: number;
    // A disposable deadline seam keeps cancellation tests independent of global timers/module mocks.
    readonly deadline?: (ms: number) => Deadline;
}): (() => Promise<GoogleModelAvailability>) => {
    const fetchFn = params.fetchFn ?? fetch;
    const now = params.now ?? Date.now;
    const deadline = params.deadline ?? deadlineAfter;
    const auth = { authorization: `Bearer ${params.token}` };
    let cached: { readonly fingerprint: string; readonly checkedAt: number; readonly value: GoogleModelAvailability } | undefined;
    let inFlight: Promise<GoogleModelAvailability> | undefined;

    const readJson = async <Value>(
        path: string,
        init: RequestInit,
        schema: z.ZodType<Value>,
        sweepSignal: AbortSignal,
    ): Promise<Value | undefined> => {
        const requestDeadline = deadline(params.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([sweepSignal, requestDeadline.signal]);
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const cancelBody = (): void => {
            const cancellation = reader === undefined ? response?.body?.cancel() : reader.cancel();
            // allow(silent-catch): cancellation can reject after a stream has closed; the observation is already unknown.
            void cancellation?.catch(() => undefined);
        };
        let onAbort: () => void = () => undefined;
        const aborted = new Promise<undefined>((resolve) => {
            onAbort = () => {
                cancelBody();
                resolve(undefined);
            };
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
        const read = async (): Promise<Value | undefined> => {
            if (signal.aborted) {
                return undefined;
            }
            response = await fetchFn(`${params.managementUrl}${path}`, { ...init, signal });
            // A fetch seam can ignore abort and resolve late. Cancel its body and never consume that old answer.
            if (signal.aborted || !response.ok) {
                cancelBody();
                return undefined;
            }
            if (response.body === null) {
                return undefined;
            }
            reader = response.body.getReader();
            try {
                const decoder = new TextDecoder();
                let body = "";
                while (!signal.aborted) {
                    const chunk = await reader.read();
                    if (chunk.done) {
                        return signal.aborted ? undefined : schema.parse(JSON.parse(body + decoder.decode()));
                    }
                    body += decoder.decode(chunk.value, { stream: true });
                }
                return undefined;
            } finally {
                reader.releaseLock();
            }
        };
        try {
            // Race the full body read too, so an uncooperative fetch/stream cannot hold the getter past its deadline.
            // allow(silent-catch): any transport or JSON failure is an unknown observation, never an empty model set.
            return await Promise.race([read().catch(() => undefined), aborted]);
        } finally {
            signal.removeEventListener("abort", onAbort);
            requestDeadline.dispose();
        }
    };

    const readAccount = async (account: GoogleAccount, signal: AbortSignal): Promise<readonly string[] | undefined> => {
        if (account.authIndex === undefined || account.project === undefined || signal.aborted) {
            return undefined;
        }
        const result = await readJson(
            "/api-call",
            {
                method: "POST",
                headers: { ...auth, "content-type": "application/json" },
                body: JSON.stringify({
                    auth_index: account.authIndex,
                    method: "POST",
                    url: MODELS_URL,
                    header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": GOOGLE_USER_AGENT },
                    data: JSON.stringify({ project: account.project }),
                }),
            },
            ApiCallSchema,
            signal,
        );
        if (signal.aborted || result === undefined) {
            return undefined;
        }
        try {
            return ModelIdsSchema.parse(JSON.parse(result.body));
        } catch {
            // allow(silent-catch): a malformed inner payload is unknown for this account, not a verified empty list.
            return undefined;
        }
    };

    const sweep = async (accounts: readonly GoogleAccount[], signal: AbortSignal): Promise<GoogleModelAvailability> => {
        const successful: (readonly string[])[] = [];
        let cursor = 0;
        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, async () => {
                while (!signal.aborted && cursor < accounts.length) {
                    const index = cursor++;
                    const account = accounts[index];
                    if (account !== undefined) {
                        const models = await readAccount(account, signal);
                        if (!signal.aborted && models !== undefined) {
                            successful.push(models);
                        }
                    }
                }
            }),
        );
        let intersection = new Set(successful[0] ?? []);
        for (const models of successful.slice(1)) {
            const ids = new Set(models);
            intersection = new Set([...intersection].filter((id) => ids.has(id)));
        }
        const models = [...intersection].sort();
        return successful.length === accounts.length
            ? { state: "verified", accounts: accounts.length, models }
            : { state: "incomplete", accounts: accounts.length, verified: successful.length, models };
    };

    const refresh = async (): Promise<GoogleModelAvailability> => {
        const sweepDeadline = deadline(params.sweepTimeoutMs ?? SWEEP_TIMEOUT_MS);
        try {
            // Deliberately independent of translator.ts's disk fallback: only the running proxy knows its rotation.
            const inventory = await readJson("/auth-files", { method: "GET", headers: auth }, InventorySchema, sweepDeadline.signal);
            if (inventory === undefined) {
                cached = undefined;
                return { state: "unknown" };
            }
            const checkedAt = now();
            const age = cached === undefined ? CACHE_TTL_MS : checkedAt - cached.checkedAt;
            if (cached?.fingerprint === inventory.fingerprint && age >= 0 && age < CACHE_TTL_MS) {
                return cached.value;
            }
            cached = undefined;
            const value = await sweep(inventory.accounts, sweepDeadline.signal);
            // No fallback to the expired proof. Unsuccessful observations without any proof can be retried immediately.
            if (value.state === "verified" || (value.state === "incomplete" && value.verified > 0)) {
                cached = { fingerprint: inventory.fingerprint, checkedAt, value };
            }
            return value;
        } finally {
            sweepDeadline.dispose();
        }
    };

    return () => {
        if (inFlight === undefined) {
            // Only this execution may write the cache; timed-out transport promises have no path back into it.
            const execution = Promise.resolve().then(refresh);
            const shared = execution.finally(() => {
                if (inFlight === shared) {
                    inFlight = undefined;
                }
            });
            inFlight = shared;
        }
        return inFlight;
    };
};
