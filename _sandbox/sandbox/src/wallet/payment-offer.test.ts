import type { AgentEvent, WalletConfig } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { gatedPaidFetch, type PaidFetchRequest, type PaymentGateDeps } from "./payment-offer.js";
import type { PaymentRow, WalletLedgerStore } from "./wallet-ledger.js";

/* The payment gate, driven end to end with a fake endpoint, a fake signer and a fake live turn: what these
 * prove is the ONE property the module exists for: a signature is requested exactly when the owner's
 * policy allowed it AND (outside their standing band) a real click approved it, and every other ending
 * spends nothing and answers with a sentence the agent can act on.
 *
 * The fake endpoint answers 402 with a real v2 challenge first and 200 to the retry that carries payment,
 * which is the actual protocol handshake rather than a stub of it. */

const ADDRESS = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

const challengeFor = (amountAtomic: string, over: Record<string, unknown> = {}): string =>
    base64({
        x402Version: 2,
        resource: { url: "https://api.example.com/premium", description: "Premium market data" },
        accepts: [
            {
                scheme: "exact",
                network: "eip155:8453",
                amount: amountAtomic,
                asset: USDC_BASE,
                payTo: PAY_TO,
                maxTimeoutSeconds: 60,
                extra: { name: "USD Coin", version: "2" },
                ...over,
            },
        ],
    });

const wallet = (over: Partial<WalletConfig> = {}): WalletConfig => ({
    network: "eip155:8453",
    address: ADDRESS,
    perPaymentMaxUsd: "1.00",
    autoApproveUnderUsd: "0",
    dailyCapUsd: "5.00",
    ...over,
});

// A ledger in memory with the real store's semantics: open/settle/record, and the same spent-today rule
// (paid plus in-flight), because the cap arithmetic is exactly what these tests are checking.
const memoryLedger = (seed: readonly PaymentRow[] = []): WalletLedgerStore & { readonly rows: PaymentRow[] } => {
    const rows: PaymentRow[] = [...seed];
    let next = 0;
    return {
        rows,
        open: async (payment) => {
            const id = `row-${(next += 1)}`;
            rows.push({ id, at: Date.now(), outcome: "pending", ...payment, ...(payment.why !== undefined ? { why: payment.why } : {}) });
            return id;
        },
        settle: async (id, outcome, transaction) => {
            const index = rows.findIndex((row) => row.id === id);
            if (index >= 0) {
                rows[index] = { ...rows[index]!, outcome, ...(transaction !== undefined ? { transaction } : {}) };
            }
        },
        record: async (payment, outcome) => {
            rows.push({ id: `row-${(next += 1)}`, at: Date.now(), outcome, ...payment });
        },
        all: async () => rows,
    };
};

interface Fake {
    readonly deps: PaymentGateDeps;
    readonly frames: AgentEvent[];
    readonly signed: unknown[];
    readonly ledger: WalletLedgerStore & { readonly rows: PaymentRow[] };
    readonly paidHeaders: (string | null)[];
}

const fake = (
    over: Partial<PaymentGateDeps> = {},
    endpoint?: { readonly challenge?: string; readonly retryStatus?: number; readonly settlement?: unknown },
): Fake => {
    const frames: AgentEvent[] = [];
    const signed: unknown[] = [];
    const paidHeaders: (string | null)[] = [];
    const ledger = memoryLedger();
    const deps: PaymentGateDeps = {
        wallet: async () => wallet(),
        ledger,
        sign: async (request) => {
            signed.push(request);
            return { status: 200, contentType: "application/json", body: JSON.stringify({ signature: `0x${"ab".repeat(65)}` }) };
        },
        fetchFn: (async (_url: string | URL, init?: RequestInit) => {
            const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
            paidHeaders.push(header);
            if (header === null) {
                return new Response("", { status: 402, headers: { "payment-required": endpoint?.challenge ?? challengeFor("100000") } });
            }
            return new Response(`{"data":"ok"}`, {
                status: endpoint?.retryStatus ?? 200,
                headers: {
                    "content-type": "application/json",
                    "payment-response": base64(endpoint?.settlement ?? { success: true, transaction: "0xdeadbeef", network: "eip155:8453" }),
                },
            });
        }) as unknown as typeof fetch,
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        tainted: () => false,
        ...over,
    };
    return { deps, frames, signed, ledger, paidHeaders };
};

const asked = (over: Partial<PaidFetchRequest> = {}): PaidFetchRequest => ({
    url: "https://api.example.com/premium",
    method: "GET",
    body: undefined,
    contentType: undefined,
    maxUsd: undefined,
    why: "the free tier has no intraday data",
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

const answerCard = async (frames: AgentEvent[], approve: boolean): Promise<void> => {
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const raised = frames[0]!;
    if (raised.kind !== "payment_offer") {
        throw new Error(`expected a payment_offer frame, got ${raised.kind}`);
    }
    resolveRequest({ kind: "payment_offer", requestId: raised.requestId, approve });
};

it("pays only after the click, and receipts the endpoint's own settlement", async () => {
    const { deps, frames, signed, ledger, paidHeaders } = fake();
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, true);
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect(answer.paidUsd).toBe("0.10");
    expect(answer.transaction).toBe("0xdeadbeef");
    // The unpaid probe went first, then exactly one retry carrying the payment header.
    expect(paidHeaders).toEqual([null, expect.any(String)]);
    expect(signed).toHaveLength(1);
    // Every number on the card is the CHALLENGE's, and the agent's contribution is the one `why` line.
    expect(frames[0]).toMatchObject({
        kind: "payment_offer",
        offer: { amountUsd: "0.10", payTo: PAY_TO, network: "eip155:8453", dailyCapUsd: "5.00", why: "the free tier has no intraday data" },
    });
    expect(frames.map((frame) => frame.kind)).toEqual(["payment_offer", "resolved", "payment_receipt"]);
    expect(frames[2]).toMatchObject({ kind: "payment_receipt", outcome: "paid", amountUsd: "0.10", transaction: "0xdeadbeef" });
    expect(ledger.rows.at(-1)).toMatchObject({ outcome: "paid", amountUsd: "0.10", host: "api.example.com" });
});

it("a skip signs nothing and tells the agent to continue without it", async () => {
    const { deps, frames, signed, ledger } = fake();
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, false);
    const answer = await pending;
    expect(answer.status).toBe(403);
    expect(signed).toEqual([]);
    expect(answer.body).toContain("nothing was spent");
    expect(ledger.rows.at(-1)).toMatchObject({ outcome: "declined" });
});

it("an unanswered offer expires without spending, and says nobody answered", async () => {
    const { deps, signed } = fake({ deadlineMs: 10 });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(408);
    expect(signed).toEqual([]);
    expect(answer.body).toContain("unanswered");
});

it("refuses a price over the per-payment ceiling without even raising a card", async () => {
    const { deps, frames, signed } = fake({}, { challenge: challengeFor("2500000") });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("per-payment ceiling");
    expect(frames).toEqual([]);
    expect(signed).toEqual([]);
});

it("refuses when the day's cap is already committed, counting in-flight payments", async () => {
    const ledger = memoryLedger([
        { id: "old", at: Date.now(), url: "https://x", host: "x", payTo: PAY_TO, network: "eip155:8453", amountUsd: "4.50", outcome: "paid" },
        // A pending row is money whose fate is unknown: it holds against the cap, conservatively.
        { id: "flight", at: Date.now(), url: "https://y", host: "y", payTo: PAY_TO, network: "eip155:8453", amountUsd: "0.45", outcome: "pending" },
    ]);
    const { deps, signed, frames } = fake({ ledger });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("daily cap");
    expect(frames).toEqual([]);
    expect(signed).toEqual([]);
});

it("honours the agent's own --max as a narrowing bound", async () => {
    const { deps, signed } = fake();
    const answer = await gatedPaidFetch(deps, asked({ maxUsd: "0.05" }));
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("--max");
    expect(signed).toEqual([]);
});

it("pays without a card inside the owner's auto-approve band", async () => {
    const { deps, frames, signed } = fake({ wallet: async () => wallet({ autoApproveUnderUsd: "0.25" }) });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(200);
    expect(signed).toHaveLength(1);
    // No card, and therefore no card frames: the owner's standing delegation covered it.
    expect(frames).toEqual([]);
});

it("suspends the auto-approve band on a turn that has read outside content", async () => {
    // The delegation covers the AGENT's judgment about small payments; a fetched page is what replaces that
    // judgment, so the same payment that would have gone through silently now asks in chat instead.
    const { deps, frames, signed } = fake({ wallet: async () => wallet({ autoApproveUnderUsd: "0.25" }), tainted: () => true });
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, true);
    expect((await pending).status).toBe(200);
    expect(signed).toHaveLength(1);
    // It asked (the whole point) rather than refusing or paying silently.
    expect(frames[0]).toMatchObject({ kind: "payment_offer" });
});

it("still cards a payment inside the band when the host is not on the allow list", async () => {
    const { deps, frames } = fake({ wallet: async () => wallet({ autoApproveUnderUsd: "0.25", allow: "trusted.example" }) });
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, true);
    expect((await pending).status).toBe(200);
});

it("refuses a denied host outright, whatever the price", async () => {
    const { deps, signed, frames } = fake({ wallet: async () => wallet({ autoApproveUnderUsd: "1.00", deny: "example.com" }) });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("deny list");
    expect(frames).toEqual([]);
    expect(signed).toEqual([]);
});

it("refuses a rail the wallet does not hold, naming what the endpoint accepts", async () => {
    const { deps, signed } = fake({}, { challenge: challengeFor("100000", { network: "eip155:1", asset: "0xdac17f958d2ee523a2206206994597c13d831ec7" }) });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(409);
    expect(answer.body).toContain("rails this wallet does not hold");
    expect(signed).toEqual([]);
});

it("passes a free endpoint straight through without a card or a signature", async () => {
    const { deps, frames, signed } = fake({
        fetchFn: (async () => new Response(`{"free":true}`, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    const answer = await gatedPaidFetch(deps, asked());
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(`{"free":true}`);
    expect(answer.paidUsd).toBeUndefined();
    expect(frames).toEqual([]);
    expect(signed).toEqual([]);
});

it("reports a settlement failure as spending nothing, and settles the ledger row failed", async () => {
    const { deps, frames, ledger } = fake({}, { retryStatus: 402, settlement: { success: false, errorReason: "insufficient_funds" } });
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, true);
    const answer = await pending;
    expect(answer.status).toBe(502);
    expect(answer.body).toContain("insufficient_funds");
    expect(answer.body).toContain("nothing was spent");
    expect(ledger.rows.at(-1)).toMatchObject({ outcome: "failed" });
    expect(frames.at(-1)).toMatchObject({ kind: "payment_receipt", outcome: "failed" });
});

it("refuses when the platform declines to sign, without retrying the endpoint", async () => {
    const { deps, frames, paidHeaders, ledger } = fake({
        sign: async () => ({ status: 403, contentType: "application/json", body: `{"error":"over the daily cap"}` }),
    });
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, true);
    const answer = await pending;
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("declined to sign");
    // Only the unpaid probe ever went out.
    expect(paidHeaders).toEqual([null]);
    expect(ledger.rows.at(-1)).toMatchObject({ outcome: "refused" });
});

it("refuses the payment when the ledger cannot be written: no spend without a record", async () => {
    const ledger = memoryLedger();
    const { deps, frames, signed } = fake({
        ledger: { ...ledger, open: async () => { throw new Error("disk full"); } },
    });
    const pending = gatedPaidFetch(deps, asked());
    await answerCard(frames, true);
    const answer = await pending;
    expect(answer.status).toBe(500);
    expect(signed).toEqual([]);
});

it("refuses without a wallet, and without a live conversation to ask in", async () => {
    const { deps: noWallet } = fake({ wallet: async () => undefined });
    expect((await gatedPaidFetch(noWallet, asked())).status).toBe(409);
    const { deps: noRun, signed } = fake({ liveRun: () => undefined });
    const answer = await gatedPaidFetch(noRun, asked());
    expect(answer.status).toBe(409);
    expect(answer.body).toContain("live conversation");
    expect(signed).toEqual([]);
});

it("refuses a plain-http URL: a challenge over http could be anyone's", async () => {
    const { deps } = fake();
    expect((await gatedPaidFetch(deps, asked({ url: "http://api.example.com/premium" }))).status).toBe(400);
});
