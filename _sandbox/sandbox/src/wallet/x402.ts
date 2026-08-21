import { randomBytes } from "node:crypto";

/* THE x402 WIRE, parsing a 402 challenge into one normalized quote, and building the payment the retry
 * carries. Pure protocol logic: no network, no policy, no keys, the gate (payment-offer.ts) owns consent
 * and the platform owns the signature, so everything here is testable with strings.
 *
 * TWO WIRE VERSIONS, ONE INTERNAL SHAPE. The protocol's current revision (v2) carries the challenge in a
 * `PAYMENT-REQUIRED` response header and takes payment back in `PAYMENT-SIGNATURE`; the original (v1) put
 * the challenge in the 402's JSON body and took `X-PAYMENT`. Both are live on the open web, so the CLIENT
 * speaks both, but as parsers in and one builder out of the same PaymentQuote, per this repo's no-legacy
 * rule: internal types are v2-native, v1 is a wire adapter, and dropping it one day deletes a parser and
 * nothing else. A third 402 dialect exists (MPP's `WWW-Authenticate: Payment` scheme, the Stripe-backed
 * rail WunderCorp's gateways speak), recognized and refused by name, because a wrong-protocol refusal the
 * agent can read beats a parse failure it cannot.
 *
 * ONLY THE "EXACT" SCHEME, ONLY USDC. The exact scheme is an EIP-3009 transferWithAuthorization: an OFFLINE
 * authorization for one transfer of one exact amount, signed as EIP-712 typed data and settled by the
 * MERCHANT's side (they pay the gas; the wallet needs no ETH and never submits a transaction). That shape is
 * what makes agent payments safe to automate at all, the signature is a bearer instrument for exactly that
 * transfer and nothing else, and an unused one simply expires. USDC-only is what keeps the policy math
 * honest: the owner's caps are written in dollars, and only a dollar-pegged token makes "amount ≤ cap" a
 * fact rather than an exchange-rate guess. */

// USDC per supported network: the token contract, its EIP-712 domain defaults, and the explorer that renders
// a settlement hash. This table is the compliance surface, an asset not on it is refused, which is the
// USDC-only rule enforced as a lookup rather than a judgment.
export interface UsdcNetwork {
    // CAIP-2 ("eip155:8453"), the v2 vocabulary and the wallet config's.
    readonly network: string;
    // How v1 challenges spell the same chain ("base"), matched on parse, echoed on the v1 retry header.
    readonly v1Network: string;
    readonly chainId: number;
    readonly asset: string;
    // EIP-712 domain fallbacks, a challenge's `extra.{name,version}` wins when present, because the domain
    // must match what the token contract itself hashes and the server publishing the price knows its token.
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

// USDC has six decimals, and every amount in this module is a bigint of its atomic units, floats never
// touch money. The USD string forms ("1.50") are the display and policy vocabulary; these two are the only
// crossings between the vocabularies, so a rounding bug has one place to not exist.
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

/* One payable price off a challenge, normalized: everything the policy check, the card, and the retry
 * builder need, in one vocabulary regardless of which wire version said it. `requirement` and `resource`
 * keep the server's own objects verbatim, the v2 retry must echo the accepted requirement exactly as
 * offered (the server matches on it), and a normalized copy would be a second spelling to drift. */
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

// One v1 `accepts` entry → the same quote. v1 spells things differently on purpose-preserving fields only:
// `maxAmountRequired` for the price (the exact scheme makes it exact), `resource` as a bare URL string, and
// the network as a name ("base") rather than CAIP-2.
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
    // MPP: a different machine-payments protocol (the `Payment` HTTP auth scheme; Stripe SPT and payment
    // channels). Named honestly instead of parsed badly.
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

/* The EIP-3009 authorization the platform signs: one transfer of exactly `value`, from the wallet, to the
 * challenge's payTo, valid for a window bounded by the challenge's own timeout (and 300s regardless, a
 * longer-lived bearer instrument helps nobody). The nonce is 32 random bytes, the standard's replay guard:
 * the token contract burns it on settlement, so the same authorization can never move money twice. Times as
 * decimal-string seconds and value as decimal-string atomic units, the x402 payload's own spelling. */
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

// The retry's payment header, in the challenge's own wire version: v2 echoes the accepted requirement and
// resource verbatim inside PAYMENT-SIGNATURE; v1 wraps the same payload in X-PAYMENT with its network name.
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

// The settlement the server reports back (v2 PAYMENT-RESPONSE / v1 X-PAYMENT-RESPONSE): success, the onchain
// transaction hash, and, on failure, the server's own reason. Absent header ⇒ undefined, and the caller
// falls back to what the HTTP status proves.
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

// The wallet's live USDC balance, read straight off the chain's public RPC, balanceOf(address) is one
// eth_call with a hand-built selector, which is what keeps chain SDKs out of the daemon entirely. Undefined
// on any failure: a balance is a nicety on a status card, never something a payment path waits on.
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
