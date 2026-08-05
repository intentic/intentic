import { z } from "zod";

// A thin typed wrapper over the Stripe REST API — only the one operation intentic needs in v1: confirm an
// API key is valid by reading the account. Auth is the secret key as a Bearer token. Injectable for tests
// (same pattern as DiscordApi / KomodoApi).

const API_BASE = "https://api.stripe.com/v1";

export interface StripeAccount {
    readonly id: string;
}

const accountSchema = z.object({ id: z.string() });

export interface StripeApi {
    // GET /v1/account — the account for a valid key, or undefined when the key is rejected (401/403).
    readonly getAccount: (apiKey: string) => Promise<StripeAccount | undefined>;
}

export const stripeApi: StripeApi = {
    getAccount: async (apiKey) => {
        // Timeout bounds a stalled connection (undici's default headers timeout is ~5 minutes).
        const response = await fetch(`${API_BASE}/account`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
        if (response.status === 401 || response.status === 403) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`Stripe GET /account failed (HTTP ${response.status}): ${await response.text()}`);
        }
        return accountSchema.parse(await response.json());
    },
};
