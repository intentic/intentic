// The money side of x402 every tier states alike: which USDC contracts a payment may move, and dollars as atomic units.

// One chain's USDC: token contract, EIP-712 domain defaults, explorer; an asset not on the list below is refused.
export interface UsdcNetwork {
    // CAIP-2 ("eip155:8453"), the v2 vocabulary and the wallet config's.
    readonly network: string;
    // How v1 challenges spell the same chain ("base"), matched on parse, echoed on the v1 retry header.
    readonly v1Network: string;
    readonly chainId: number;
    readonly asset: string;
    // EIP-712 domain fallbacks; `extra.{name,version}` on the challenge wins when present.
    readonly domainName: string;
    readonly domainVersion: string;
    readonly label: string;
    readonly explorer: string;
    readonly rpc: string;
}

export const USDC_NETWORKS: readonly UsdcNetwork[] = [
    {
        network: "eip155:8453",
        v1Network: "base",
        chainId: 8453,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        domainName: "USD Coin",
        domainVersion: "2",
        label: "Base",
        explorer: "https://basescan.org/tx/",
        rpc: "https://mainnet.base.org",
    },
    {
        network: "eip155:84532",
        v1Network: "base-sepolia",
        chainId: 84532,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        domainName: "USDC",
        domainVersion: "2",
        label: "Base Sepolia (test)",
        explorer: "https://sepolia.basescan.org/tx/",
        rpc: "https://sepolia.base.org",
    },
];

export const usdcNetworkOf = (network: string): UsdcNetwork | undefined => USDC_NETWORKS.find((entry) => entry.network === network);

// Every amount is a bigint of atomic units, never a float; USD strings ("1.50") are the display and policy vocabulary.
export const USDC_DECIMALS = 6n;
const ATOMIC_PER_USD = 10n ** USDC_DECIMALS;

// Digits past the sixth decimal are cut, not rounded: a price is never read as more than was written.
export const usdToAtomic = (usd: string): bigint => {
    const [whole, fraction = ""] = usd.split(".");
    return BigInt(whole || "0") * ATOMIC_PER_USD + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
};

// At least cents ("1.50"), and every non-zero atomic digit after them ("0.000001").
export const atomicToUsd = (atomic: bigint): string => {
    const whole = atomic / ATOMIC_PER_USD;
    const fraction = (atomic % ATOMIC_PER_USD).toString().padStart(6, "0").replace(/0+$/, "");
    return fraction === "" ? `${whole}.00` : `${whole}.${fraction.padEnd(2, "0")}`;
};
