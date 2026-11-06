import { cachedAsync } from "@intentic/base/held";
import type { KeyBalance } from "@intentic/sandbox-contract/contracts/endpoints.contract";
import { keyProviderFor } from "@intentic/sandbox-contract/models/key-providers";
import type { EndpointConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { z } from "zod";
import { opt } from "../opt.js";
import { endpointHeaders, unversionedBase, versionedBase } from "./endpoint-config.js";

// What is left to spend on a vendor's API key, read from the vendor with the key itself: the per-token counterpart of a
// sign-in's plan limits. Only the vendors that tell an ordinary key have a reader here. Anthropic, OpenAI, Gemini and
// xAI keep billing behind an admin or management key, and OpenRouter's account credit (GET /credits) wants one too, so
// for those nothing is known rather than anything guessed.

type Reading = Omit<KeyBalance, "measuredAt">;
// All of fetch a read uses, so a test can stand in for a vendor with a plain function.
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type BalanceReader = (config: EndpointConfig, fetchImpl: Fetch) => Promise<Reading | undefined>;

// A vendor that does not answer in this long has nothing to say this time; the composer asks again after the next turn.
const READ_TIMEOUT_MS = 10_000;
// A balance moves with every turn, so it is held only long enough that a picker and a composer opened together share one
// read.
const BALANCE_TTL_MS = 30_000;

const readJson = async (url: string, config: EndpointConfig, fetchImpl: Fetch): Promise<unknown> => {
    const response = await fetchImpl(url, { headers: endpointHeaders(config), signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }
    return response.json();
};

// platform.kimi.ai/docs/api/balance: `available_balance` is cash and vouchers together, the figure the platform refuses
// inference at once it reaches zero. The international platform (api.moonshot.ai, the only base filed as Moonshot's)
// bills in dollars.
const MoonshotBalanceSchema = z.object({ data: z.object({ available_balance: z.number() }) });
const moonshot: BalanceReader = async (config, fetchImpl) => {
    const body = MoonshotBalanceSchema.safeParse(await readJson(`${versionedBase(config.baseUrl)}/users/me/balance`, config, fetchImpl));
    return body.success ? { remaining: body.data.data.available_balance, currency: "USD" } : undefined;
};

// api-docs.deepseek.com/api/get-user-balance: one row per currency the account was topped up in, each figure a decimal
// string. Dollars where the account holds any, else its first.
const DeepSeekBalanceSchema = z.object({ balance_infos: z.array(z.object({ currency: z.string().min(1), total_balance: z.string() })) });
const deepseek: BalanceReader = async (config, fetchImpl) => {
    const body = DeepSeekBalanceSchema.safeParse(await readJson(`${unversionedBase(config.baseUrl)}/user/balance`, config, fetchImpl));
    const infos = body.data?.balance_infos ?? [];
    const info = infos.find((entry) => entry.currency === "USD") ?? infos[0];
    const remaining = Number(info?.total_balance);
    return info === undefined || !Number.isFinite(remaining) ? undefined : { remaining, currency: info.currency };
};

// openrouter.ai/docs/api-reference/limits: GET /key tells a key the budget that refuses it first (one an organisation set,
// or the key's own limit), else its own credit limit. A key with neither has no cap of its own, and the account's
// credit is not the key's to read.
const OpenRouterBudgetSchema = z.object({ limit_usd: z.number(), remaining_usd: z.number(), resets_at: z.string().nullish() });
const OpenRouterKeySchema = z.object({
    data: z.object({
        limit: z.number().nullish(),
        limit_remaining: z.number().nullish(),
        effective_budget: OpenRouterBudgetSchema.nullish(),
    }),
});
const epochSeconds = (iso: string | null | undefined): number | undefined => {
    const at = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isFinite(at) ? Math.floor(at / 1000) : undefined;
};
const openrouter: BalanceReader = async (config, fetchImpl) => {
    const body = OpenRouterKeySchema.safeParse(await readJson(`${versionedBase(config.baseUrl)}/key`, config, fetchImpl));
    if (!body.success) {
        return undefined;
    }
    const { limit, limit_remaining: left, effective_budget: budget } = body.data.data;
    if (budget !== null && budget !== undefined) {
        return { remaining: budget.remaining_usd, currency: "USD", limit: budget.limit_usd, ...opt("resetsAt", epochSeconds(budget.resets_at)) };
    }
    return left === null || left === undefined ? undefined : { remaining: left, currency: "USD", ...opt("limit", limit ?? undefined) };
};

// By the vendor's id in KEY_PROVIDERS, which a key's base URL names (keyProviderFor).
const READERS: Readonly<Record<string, BalanceReader>> = { moonshot, deepseek, openrouter };

// The reader for an endpoint's vendor, if it tells its keys anything; undefined asks the vendor nothing.
const balanceReaderFor = (config: EndpointConfig): BalanceReader | undefined => {
    const vendor = keyProviderFor(config.baseUrl);
    return vendor === undefined || (config.apiKey ?? "") === "" ? undefined : READERS[vendor.id];
};

export interface KeyBalances {
    // The balance on this endpoint's key, or undefined where its vendor tells the key nothing or could not be read now.
    readonly read: (id: string, config: EndpointConfig) => Promise<KeyBalance | undefined>;
}

// fetchImpl and now are injectable so a test never reaches a vendor and controls the clock.
export const createKeyBalances = (fetchImpl: Fetch = fetch, now: () => number = Date.now): KeyBalances => {
    // Keyed by the key as well as the endpoint, so a key replaced under the same card is never answered with the old one's.
    const cache = cachedAsync<string, KeyBalance | undefined>({ ttlMs: BALANCE_TTL_MS, now });
    return {
        read: async (id, config) => {
            const reader = balanceReaderFor(config);
            if (reader === undefined) {
                return undefined;
            }
            return cache.get(`${id}\n${config.baseUrl}\n${config.apiKey ?? ""}`, async () => {
                // allow(silent-catch): a vendor that refuses or fails the read leaves the balance unknown, which is what the answer says; the next turn's read asks again.
                const reading = await reader(config, fetchImpl).catch(() => undefined);
                return reading === undefined ? undefined : { ...reading, measuredAt: now() };
            });
        },
    };
};
