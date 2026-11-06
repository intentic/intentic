import type { EndpointConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { createKeyBalances } from "./key-balance.js";

// The vendors as a key reaches them: each URL answers its own body, every other one 404s, and every ask is counted.
const vendor = (answers: Readonly<Record<string, unknown>>) => {
    const asked: { url: string; authorization: string | null }[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
        asked.push({ url, authorization: new Headers(init.headers).get("authorization") });
        const body = answers[url];
        return body === undefined ? new Response("", { status: 404 }) : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    return { asked, fetchImpl };
};

const key = (baseUrl: string, apiKey = "sk-test"): EndpointConfig => ({ baseUrl, protocol: "openai", apiKey });

test("reads Moonshot's available balance, in dollars, with the key itself", async () => {
    const { asked, fetchImpl } = vendor({
        "https://api.moonshot.ai/v1/users/me/balance": { code: 0, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 }, status: true },
    });
    expect(await createKeyBalances(fetchImpl, () => 1000).read("moonshot", key("https://api.moonshot.ai/v1"))).toEqual({
        remaining: 49.58,
        currency: "USD",
        measuredAt: 1000,
    });
    expect(asked).toEqual([{ url: "https://api.moonshot.ai/v1/users/me/balance", authorization: "Bearer sk-test" }]);
});

// DeepSeek's balance sits outside its /v1, one row per currency the account was topped up in.
test("reads DeepSeek's balance in dollars where the account holds any, else its first currency", async () => {
    const both = vendor({
        "https://api.deepseek.com/user/balance": {
            is_available: true,
            balance_infos: [
                { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
                { currency: "USD", total_balance: "12.50", granted_balance: "0.00", topped_up_balance: "12.50" },
            ],
        },
    });
    expect(await createKeyBalances(both.fetchImpl, () => 1).read("deepseek", key("https://api.deepseek.com/v1"))).toMatchObject({ remaining: 12.5, currency: "USD" });

    const yuan = vendor({ "https://api.deepseek.com/user/balance": { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00" }] } });
    expect(await createKeyBalances(yuan.fetchImpl, () => 1).read("deepseek", key("https://api.deepseek.com/v1"))).toMatchObject({ remaining: 110, currency: "CNY" });
});

// OpenRouter tells a key its own cap, and the budget an organisation set over it, never the account's credit.
test("reads an OpenRouter key's cap, the budget that refuses it first winning, and nothing for an uncapped key", async () => {
    const url = "https://openrouter.ai/api/v1/key";
    const capped = vendor({ [url]: { data: { limit: 20, limit_remaining: 7.25, usage: 12.75, effective_budget: null } } });
    expect(await createKeyBalances(capped.fetchImpl, () => 1).read("openrouter", key("https://openrouter.ai/api/v1"))).toEqual({
        remaining: 7.25,
        currency: "USD",
        limit: 20,
        measuredAt: 1,
    });

    const budgeted = vendor({
        [url]: {
            data: {
                limit: 20,
                limit_remaining: 7.25,
                effective_budget: { limit_usd: 5, spend_usd: 4, remaining_usd: 1, reset_interval: "daily", resets_at: "2026-11-07T00:00:00Z" },
            },
        },
    });
    expect(await createKeyBalances(budgeted.fetchImpl, () => 1).read("openrouter", key("https://openrouter.ai/api/v1"))).toEqual({
        remaining: 1,
        currency: "USD",
        limit: 5,
        resetsAt: Date.parse("2026-11-07T00:00:00Z") / 1000,
        measuredAt: 1,
    });

    const uncapped = vendor({ [url]: { data: { limit: null, limit_remaining: null, usage: 3, effective_budget: null } } });
    expect(await createKeyBalances(uncapped.fetchImpl).read("openrouter", key("https://openrouter.ai/api/v1"))).toBeUndefined();
});

// Anthropic's and OpenAI's keys are refused their billing, and a server of the owner's has none: no vendor is asked.
test("asks nothing of a vendor that tells its keys nothing, of a server of the owner's, or without a key", async () => {
    const { asked, fetchImpl } = vendor({});
    const balances = createKeyBalances(fetchImpl);
    expect(await balances.read("anthropic", { baseUrl: "https://api.anthropic.com", protocol: "anthropic", apiKey: "sk-ant" })).toBeUndefined();
    expect(await balances.read("openai", key("https://api.openai.com/v1"))).toBeUndefined();
    expect(await balances.read("ollama", key("http://host.docker.internal:11434/v1"))).toBeUndefined();
    expect(await balances.read("moonshot", { baseUrl: "https://api.moonshot.ai/v1", protocol: "openai" })).toBeUndefined();
    expect(asked).toEqual([]);
});

test("a refused or garbled read is no balance, never a zero", async () => {
    const refused = vendor({});
    expect(await createKeyBalances(refused.fetchImpl).read("moonshot", key("https://api.moonshot.ai/v1"))).toBeUndefined();
    const garbled = vendor({ "https://api.moonshot.ai/v1/users/me/balance": { error: { message: "nope" } } });
    expect(await createKeyBalances(garbled.fetchImpl).read("moonshot", key("https://api.moonshot.ai/v1"))).toBeUndefined();
});

// Held half a minute so a picker and a composer opened together share one read, and never across a replaced key.
test("holds a reading briefly, per key", async () => {
    const { asked, fetchImpl } = vendor({ "https://api.moonshot.ai/v1/users/me/balance": { data: { available_balance: 3 } } });
    let now = 0;
    const balances = createKeyBalances(fetchImpl, () => now);
    await balances.read("moonshot", key("https://api.moonshot.ai/v1"));
    await balances.read("moonshot", key("https://api.moonshot.ai/v1"));
    expect(asked).toHaveLength(1);

    await balances.read("moonshot", key("https://api.moonshot.ai/v1", "sk-replaced"));
    expect(asked).toHaveLength(2);

    now = 31_000;
    await balances.read("moonshot", key("https://api.moonshot.ai/v1"));
    expect(asked).toHaveLength(3);
});
