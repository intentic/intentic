import { randomBytes } from "node:crypto";

// Parses a 402 challenge into one normalized quote and builds the retry's payment; pure protocol logic, no network,
// policy or keys.
// Two wire versions, one internal shape: v2 rides PAYMENT-REQUIRED/PAYMENT-SIGNATURE headers, v1 rides a JSON body and
// X-PAYMENT; internal types are v2-native, v1 is an adapter. A third dialect (MPP) is recognized and refused by name.
// Only the exact scheme, only USDC: an EIP-3009 transferWithAuthorization settled by the merchant, so "amount ≤ cap"
// stays a fact, never an exchange-rate guess.

// USDC per supported network: token contract, EIP-712 domain defaults, explorer. The compliance surface: an asset not
// on this list is refused.
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

// USDC has six decimals; every amount here is a bigint of atomic units, never a float. USD strings ("1.50") are the
// display/policy vocabulary; usdToAtomic/atomicToUsd are the only crossing.
export const USDC_DECIMALS = 6n;
const ATOMIC_PER_USD = 10n ** USDC_DECIMALS;

export const usdToAtomic = (usd: string): bigint => {
    const [whole, fraction = ""] = usd.split(".");
    return BigInt(whole || "0") * ATOMIC_PER_USD + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
};

export const atomicToUsd = (atomic: bigint): string => {
    const whole = atomic / ATOMIC_PER_USD;
    const fraction = (atomic % ATOMIC_PER_USD).toString().padStart(6, "0").replace(/0+$/, "");
    return fraction === "" ? `${whole}.00` : `${whole}.${fraction.padEnd(2, "0")}`;
};

// One payable price normalized across wire versions, for the policy check, the card and the retry builder.
// `requirement` and `resource` keep the server's objects verbatim, since the v2 retry must echo the accepted
// requirement exactly.
export interface PaymentQuote {
    readonly x402Version: 1 | 2;
    readonly url: string;
    readonly description: string | undefined;
    readonly network: string;
    readonly amountAtomic: bigint;
    readonly asset: string;
    readonly payTo: string;
    readonly maxTimeoutSeconds: number;
    readonly domainName: string;
    readonly domainVersion: string;
    readonly v1Network: string | undefined;
    readonly requirement: unknown;
    readonly resource: unknown;
}

export type ChallengeParse =
    // At least one payable quote, the caller picks the one matching the wallet's network and token.
    | { readonly kind: "quotes"; readonly quotes: readonly PaymentQuote[] }
    // A 402 in a dialect this wallet does not pay, said by name so the agent can relay something true.
    | { readonly kind: "unsupported"; readonly reason: string }
    // A 402 with nothing challenge-shaped on it, relayed as the plain refusal it is.
    | { readonly kind: "none" };

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const asAmount = (value: unknown): bigint | undefined => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return undefined;
    }
    return BigInt(value);
};

// One v2 `accepts` entry → a quote, or nothing when it isn't an exact-scheme price this module can state.
const v2Quote = (resource: unknown, entry: unknown): PaymentQuote | undefined => {
    const requirement = entry as {
        scheme?: unknown;
        network?: unknown;
        amount?: unknown;
        asset?: unknown;
        payTo?: unknown;
        maxTimeoutSeconds?: unknown;
        extra?: { name?: unknown; version?: unknown };
    };
    const network = asString(requirement.network);
    const amount = asAmount(requirement.amount);
    const asset = asString(requirement.asset);
    const payTo = asString(requirement.payTo);
    if (requirement.scheme !== "exact" || network === undefined || amount === undefined || asset === undefined || payTo === undefined) {
        return undefined;
    }
    const known = usdcNetworkOf(network);
    const info = resource as { url?: unknown; description?: unknown } | undefined;
    return {
        x402Version: 2,
        url: asString(info?.url) ?? "",
        description: asString(info?.description),
        network,
        amountAtomic: amount,
        asset,
        payTo,
        maxTimeoutSeconds: typeof requirement.maxTimeoutSeconds === "number" ? requirement.maxTimeoutSeconds : 60,
        domainName: asString(requirement.extra?.name) ?? known?.domainName ?? "USDC",
        domainVersion: asString(requirement.extra?.version) ?? known?.domainVersion ?? "2",
        v1Network: known?.v1Network,
        requirement: entry,
        resource: resource ?? null,
    };
};

// One v1 `accepts` entry → the same quote; v1 spells the same fields differently: `maxAmountRequired` for price,
// `resource` as a bare URL, network as a name ("base") not CAIP-2.
const v1Quote = (entry: unknown): PaymentQuote | undefined => {
    const requirement = entry as {
        scheme?: unknown;
        network?: unknown;
        maxAmountRequired?: unknown;
        asset?: unknown;
        payTo?: unknown;
        resource?: unknown;
        description?: unknown;
        maxTimeoutSeconds?: unknown;
        extra?: { name?: unknown; version?: unknown };
    };
    const v1Network = asString(requirement.network);
    const amount = asAmount(requirement.maxAmountRequired);
    const asset = asString(requirement.asset);
    const payTo = asString(requirement.payTo);
    if (requirement.scheme !== "exact" || v1Network === undefined || amount === undefined || asset === undefined || payTo === undefined) {
        return undefined;
    }
    const known = USDC_NETWORKS.find((candidate) => candidate.v1Network === v1Network);
    return {
        x402Version: 1,
        url: asString(requirement.resource) ?? "",
        description: asString(requirement.description),
        network: known?.network ?? v1Network,
        amountAtomic: amount,
        asset,
        payTo,
        maxTimeoutSeconds: typeof requirement.maxTimeoutSeconds === "number" ? requirement.maxTimeoutSeconds : 60,
        domainName: asString(requirement.extra?.name) ?? known?.domainName ?? "USDC",
        domainVersion: asString(requirement.extra?.version) ?? known?.domainVersion ?? "2",
        v1Network,
        requirement: entry,
        resource: null,
    };
};

const decodeBase64Json = (value: string): unknown => {
    try {
        return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
        return undefined;
    }
};

export const parseChallenge = (url: string, headers: Headers, body: string): ChallengeParse => {
    // v2: the whole challenge rides one response header, base64-encoded.
    const v2Header = headers.get("payment-required");
    if (v2Header !== null) {
        const decoded = decodeBase64Json(v2Header) as { x402Version?: unknown; resource?: unknown; accepts?: unknown } | undefined;
        if (decoded?.x402Version === 2 && Array.isArray(decoded.accepts)) {
            const quotes = decoded.accepts.map((entry) => v2Quote(decoded.resource, entry)).filter((quote) => quote !== undefined);
            return quotes.length > 0 ? { kind: "quotes", quotes } : { kind: "unsupported", reason: "the endpoint's x402 challenge offers no exact-scheme price" };
        }
    }
    // MPP: a different machine-payments protocol (`Payment` auth scheme); named honestly, not parsed badly.
    const authenticate = headers.get("www-authenticate");
    if (authenticate !== null && /^payment[ ,]/i.test(authenticate.trim())) {
        return {
            kind: "unsupported",
            reason: "this endpoint charges over MPP (the `Payment` HTTP auth scheme), which this wallet does not speak yet, it pays x402 endpoints only",
        };
    }
    // v1: the challenge is the 402's JSON body.
    try {
        const decoded = JSON.parse(body) as { x402Version?: unknown; accepts?: unknown };
        if (decoded.x402Version === 1 && Array.isArray(decoded.accepts)) {
            const quotes = decoded.accepts.map(v1Quote).filter((quote) => quote !== undefined);
            return quotes.length > 0 ? { kind: "quotes", quotes } : { kind: "unsupported", reason: "the endpoint's x402 challenge offers no exact-scheme price" };
        }
    } catch {
        // Not JSON, a plain 402 with prose, handled below.
    }
    void url;
    return { kind: "none" };
};

// The EIP-3009 authorization the platform signs: one transfer of `value` to the challenge's payTo, capped at a 300s
// window. The 32-byte nonce is the replay guard the token contract burns on settlement. Times and value are decimal
// strings.
export interface TransferAuthorization {
    readonly from: string;
    readonly to: string;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: string;
}

const VALIDITY_CAP_S = 300;
// Starts a minute in the past so a merchant clock running slightly behind still accepts it.
const CLOCK_SKEW_S = 60;

export const mintAuthorization = (quote: PaymentQuote, from: string, nowMs: number): TransferAuthorization => {
    const nowS = Math.floor(nowMs / 1000);
    return {
        from,
        to: quote.payTo,
        value: quote.amountAtomic.toString(),
        validAfter: String(nowS - CLOCK_SKEW_S),
        validBefore: String(nowS + Math.min(Math.max(quote.maxTimeoutSeconds, 10), VALIDITY_CAP_S)),
        nonce: `0x${randomBytes(32).toString("hex")}`,
    };
};

// The retry's payment header in the challenge's own wire version: v2 echoes the requirement/resource verbatim in
// PAYMENT-SIGNATURE; v1 wraps the payload in X-PAYMENT.
export const paymentHeader = (
    quote: PaymentQuote,
    authorization: TransferAuthorization,
    signature: string,
): { readonly name: string; readonly value: string } => {
    const payload = { signature, authorization };
    if (quote.x402Version === 2) {
        const body = { x402Version: 2, resource: quote.resource, accepted: quote.requirement, payload };
        return { name: "PAYMENT-SIGNATURE", value: Buffer.from(JSON.stringify(body)).toString("base64") };
    }
    const body = { x402Version: 1, scheme: "exact", network: quote.v1Network ?? quote.network, payload };
    return { name: "X-PAYMENT", value: Buffer.from(JSON.stringify(body)).toString("base64") };
};

// The settlement the server reports (v2 PAYMENT-RESPONSE / v1 X-PAYMENT-RESPONSE): success, the transaction hash, and a
// failure reason. Absent header means undefined; the caller falls back to the HTTP status.
export interface Settlement {
    readonly success: boolean;
    readonly transaction: string | undefined;
    readonly network: string | undefined;
    readonly errorReason: string | undefined;
}

export const parseSettlement = (headers: Headers): Settlement | undefined => {
    const raw = headers.get("payment-response") ?? headers.get("x-payment-response");
    if (raw === null) {
        return undefined;
    }
    const decoded = decodeBase64Json(raw) as { success?: unknown; transaction?: unknown; network?: unknown; errorReason?: unknown } | undefined;
    if (decoded === undefined || typeof decoded.success !== "boolean") {
        return undefined;
    }
    return {
        success: decoded.success,
        transaction: asString(decoded.transaction),
        network: asString(decoded.network),
        errorReason: asString(decoded.errorReason),
    };
};

// Live USDC balance off the chain's public RPC: balanceOf(address) as one hand-built eth_call, keeping chain SDKs out
// of the daemon. Undefined on any failure; a nicety for a status card, never something a payment path waits on.
export const usdcBalance = async (network: UsdcNetwork, address: string, fetchFn: typeof fetch = fetch): Promise<bigint | undefined> => {
    try {
        const data = `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
        const response = await fetchFn(network.rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: network.asset, data }, "latest"] }),
            signal: AbortSignal.timeout(5000),
        });
        const answer = (await response.json()) as { result?: unknown };
        return typeof answer.result === "string" && /^0x[0-9a-fA-F]*$/.test(answer.result) ? BigInt(answer.result) : undefined;
    } catch {
        return undefined;
    }
};
