import type { Config } from "../config.js";

/* THE CUSTODY PROVIDER — where a member's signing key actually lives, and the one design decision this
 * whole feature rests on.
 *
 * The platform does NOT hold private keys. It holds an API credential for a wallet-custody service (a
 * Coinbase CDP / Circle-shaped provider: create a wallet, sign typed data with it, never export it), and
 * every signature is an authenticated call against a wallet filed under one member's account. That keeps
 * three things true at once: the sandbox cannot reach a key (it is not even on this machine), a platform
 * database leak yields no keys either, and the party holding custody is one that is regulated to.
 *
 * ONE ACCOUNT'S WALLET, NEVER A POOL. Every call names the member's own wallet id; the platform never
 * aggregates balances, nets payments between accounts, or moves value that is not the signing member's.
 * That is what keeps this an instruction channel rather than a money-transmission business, and it is a
 * property of this file more than of any policy document.
 *
 * The wire is deliberately small and provider-shaped rather than provider-specific: two calls, both plain
 * JSON over fetch, so no chain SDK enters this codebase and swapping providers is this file. Everything
 * 404s when unconfigured (walletEnabled below), the pool's own pattern — a self-hosted platform that has
 * not set a custody credential has no wallet feature, and says so tersely. */

export interface CustodyWallet {
    readonly id: string;
    readonly address: string;
}

// The EIP-712 typed data an EIP-3009 transferWithAuthorization is signed as. Built by the caller from the
// sandbox's relayed challenge, sent whole — the provider signs exactly this and returns a 65-byte signature.
export interface TypedData {
    readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
    readonly primaryType: "TransferWithAuthorization";
    readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
    readonly message: Record<string, string>;
}

export interface CustodyGateway {
    // Create-or-return this member's wallet on `network`. Idempotent on the provider's side by `reference`,
    // which is the platform's own stable id for the member+network pair.
    readonly wallet: (reference: string, network: string) => Promise<CustodyWallet>;
    readonly signTypedData: (walletId: string, typedData: TypedData) => Promise<string>;
}

export const walletEnabled = (config: Config): boolean => config.wallet.custodyUrl !== `` && config.wallet.custodyKey !== ``;

const call = async (config: Config, fetchFn: typeof fetch, path: string, body: unknown): Promise<unknown> => {
    const response = await fetchFn(new URL(path, config.wallet.custodyUrl), {
        method: `POST`,
        headers: { "content-type": `application/json`, authorization: `Bearer ${config.wallet.custodyKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
        // The provider's own words, bounded — a custody refusal ("insufficient balance", "wallet frozen") is
        // already written for a human, and rewriting it would blur who said what (the pool relay's rule).
        throw new Error(`the custody provider refused (${response.status}): ${text.slice(0, 300)}`);
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(`the custody provider's answer was not JSON`);
    }
};

export const custodyGateway = (config: Config, fetchFn: typeof fetch = fetch): CustodyGateway => ({
    wallet: async (reference, network) => {
        const answer = (await call(config, fetchFn, `/v1/wallets`, { reference, network })) as { id?: unknown; address?: unknown };
        if (typeof answer.id !== `string` || typeof answer.address !== `string` || !/^0x[0-9a-fA-F]{40}$/.test(answer.address)) {
            throw new Error(`the custody provider returned no usable wallet`);
        }
        return { id: answer.id, address: answer.address };
    },
    signTypedData: async (walletId, typedData) => {
        const answer = (await call(config, fetchFn, `/v1/wallets/${encodeURIComponent(walletId)}/sign-typed-data`, { typedData })) as {
            signature?: unknown;
        };
        if (typeof answer.signature !== `string` || !/^0x[0-9a-fA-F]{130}$/.test(answer.signature)) {
            throw new Error(`the custody provider returned no usable signature`);
        }
        return answer.signature;
    },
});
