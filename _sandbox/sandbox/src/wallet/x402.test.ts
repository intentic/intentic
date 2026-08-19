import { expect, it } from "vitest";
import { atomicToUsd, mintAuthorization, parseChallenge, parseSettlement, paymentHeader, usdToAtomic } from "./x402.js";

/* The wire, driven with the strings a real endpoint would actually send: what these prove is that a price
 * this wallet is about to pay is READ from the server's own challenge rather than assembled from anything
 * nearby, that both live protocol revisions land in one internal shape, and that the two 402 dialects this
 * wallet does not pay are refused by name instead of misparsed into a payment. */

const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

const V2_CHALLENGE = {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: "https://api.example.com/premium", description: "Premium market data", mimeType: "application/json" },
    accepts: [
        {
            scheme: "exact",
            network: "eip155:8453",
            amount: "100000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            maxTimeoutSeconds: 60,
            extra: { name: "USD Coin", version: "2" },
        },
    ],
};

it("converts USD and atomic units without floats, in both directions", () => {
    expect(usdToAtomic("1.00")).toBe(1_000_000n);
    expect(usdToAtomic("0.1")).toBe(100_000n);
    expect(usdToAtomic("0.000001")).toBe(1n);
    // The classic float trap: 0.1 + 0.2 in binary floating point is not 0.3, and money must not care.
    expect(usdToAtomic("0.1") + usdToAtomic("0.2")).toBe(usdToAtomic("0.3"));
    expect(atomicToUsd(1_000_000n)).toBe("1.00");
    expect(atomicToUsd(100_000n)).toBe("0.10");
    expect(atomicToUsd(1n)).toBe("0.000001");
});

it("reads a v2 challenge off the response header", () => {
    const parsed = parseChallenge(
        "https://api.example.com/premium",
        new Headers({ "payment-required": base64(V2_CHALLENGE) }),
        "",
    );
    expect(parsed.kind).toBe("quotes");
    if (parsed.kind !== "quotes") return;
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0]).toMatchObject({
        x402Version: 2,
        url: "https://api.example.com/premium",
        network: "eip155:8453",
        amountAtomic: 100_000n,
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        domainName: "USD Coin",
    });
});

it("reads a v1 challenge off the 402 body, and normalizes its network name to CAIP-2", () => {
    const body = JSON.stringify({
        x402Version: 1,
        accepts: [
            {
                scheme: "exact",
                network: "base",
                maxAmountRequired: "50000",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
                resource: "https://api.example.com/v1",
                description: "One lookup",
            },
        ],
    });
    const parsed = parseChallenge("https://api.example.com/v1", new Headers(), body);
    expect(parsed.kind).toBe("quotes");
    if (parsed.kind !== "quotes") return;
    // The whole point of the adapter: a v1 wire lands in the same vocabulary the policy check reads.
    expect(parsed.quotes[0]).toMatchObject({ x402Version: 1, network: "eip155:8453", v1Network: "base", amountAtomic: 50_000n });
});

it("refuses the MPP dialect by name rather than misreading it as an x402 price", () => {
    const parsed = parseChallenge(
        "https://mpp.example.com/plan",
        new Headers({ "www-authenticate": `Payment id="abc", realm="mpp.example.com", method="stripe", intent="charge"` }),
        `{"type":"https://paymentauth.org/problems/payment-required","status":402}`,
    );
    expect(parsed.kind).toBe("unsupported");
    if (parsed.kind !== "unsupported") return;
    expect(parsed.reason).toContain("MPP");
});

it("treats a 402 with no machine-readable challenge as no challenge at all", () => {
    expect(parseChallenge("https://api.example.com/x", new Headers(), "please subscribe").kind).toBe("none");
});

it("refuses a challenge that offers no exact-scheme price", () => {
    const parsed = parseChallenge(
        "https://api.example.com/premium",
        new Headers({ "payment-required": base64({ ...V2_CHALLENGE, accepts: [{ ...V2_CHALLENGE.accepts[0], scheme: "upto" }] }) }),
        "",
    );
    expect(parsed.kind).toBe("unsupported");
});

it("mints an authorization bounded by the challenge's own timeout, capped at five minutes", () => {
    const now = 1_800_000_000_000;
    const quotes = parseChallenge("https://api.example.com/premium", new Headers({ "payment-required": base64(V2_CHALLENGE) }), "");
    if (quotes.kind !== "quotes") throw new Error("expected quotes");
    const authorization = mintAuthorization(quotes.quotes[0]!, "0x857b06519E91e3A54538791bDbb0E22373e36b66", now);
    expect(authorization.value).toBe("100000");
    expect(authorization.to).toBe("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
    // 60s from the challenge, and the window opens a minute early to tolerate a merchant's slow clock.
    expect(Number(authorization.validBefore) - Math.floor(now / 1000)).toBe(60);
    expect(Number(authorization.validAfter)).toBe(Math.floor(now / 1000) - 60);
    // 32 bytes of randomness, the standard's replay guard.
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
});

it("caps an over-long validity window rather than signing what the endpoint asked for", () => {
    const greedy = { ...V2_CHALLENGE, accepts: [{ ...V2_CHALLENGE.accepts[0], maxTimeoutSeconds: 86_400 }] };
    const parsed = parseChallenge("https://api.example.com/premium", new Headers({ "payment-required": base64(greedy) }), "");
    if (parsed.kind !== "quotes") throw new Error("expected quotes");
    const now = 1_800_000_000_000;
    const authorization = mintAuthorization(parsed.quotes[0]!, "0x857b06519E91e3A54538791bDbb0E22373e36b66", now);
    expect(Number(authorization.validBefore) - Math.floor(now / 1000)).toBe(300);
});

it("builds the retry header in the challenge's own wire version", () => {
    const v2 = parseChallenge("https://api.example.com/premium", new Headers({ "payment-required": base64(V2_CHALLENGE) }), "");
    if (v2.kind !== "quotes") throw new Error("expected quotes");
    const authorization = mintAuthorization(v2.quotes[0]!, "0x857b06519E91e3A54538791bDbb0E22373e36b66", 1_800_000_000_000);
    const header = paymentHeader(v2.quotes[0]!, authorization, `0x${"ab".repeat(65)}`);
    expect(header.name).toBe("PAYMENT-SIGNATURE");
    const decoded = JSON.parse(Buffer.from(header.value, "base64").toString("utf8")) as Record<string, unknown>;
    expect(decoded["x402Version"]).toBe(2);
    // The server matches the retry against the requirement it offered, so it rides back verbatim.
    expect(decoded["accepted"]).toEqual(V2_CHALLENGE.accepts[0]);
});

it("reads the settlement the server reports, in either header spelling", () => {
    const settled = { success: true, transaction: "0xdeadbeef", network: "eip155:8453", payer: "0x857b" };
    expect(parseSettlement(new Headers({ "payment-response": base64(settled) }))).toMatchObject({ success: true, transaction: "0xdeadbeef" });
    expect(parseSettlement(new Headers({ "x-payment-response": base64({ success: false, errorReason: "insufficient_funds" }) }))).toMatchObject({
        success: false,
        errorReason: "insufficient_funds",
    });
    expect(parseSettlement(new Headers())).toBeUndefined();
});
