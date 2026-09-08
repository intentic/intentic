import type { Config } from "../config.js";

// Signing keys live with a custody provider (Coinbase CDP/Circle-shaped): the platform holds only an API credential,
// never a key, so neither the sandbox nor a database leak can reach one. Every call names one member's own wallet,
// never a pool, which keeps this an instruction channel, not money transmission.

export interface CustodyWallet {
    readonly id: string;
    readonly address: string;
}

// EIP-712 typed data for an EIP-3009 transferWithAuthorization, built by the caller from the sandbox's relayed
// challenge; the provider signs exactly this and returns a 65-byte signature.
export interface TypedData {
    readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
    readonly primaryType: "TransferWithAuthorization";
    readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
    readonly message: Record<string, string>;
}

export interface CustodyGateway {
    // Creates or returns this member's wallet on `network`; idempotent by `reference`, the member+network's own id.
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
        // Provider's own words, bounded: a refusal is already written for a human; rewriting it would blur who said it.
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
