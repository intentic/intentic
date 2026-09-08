import type { PaymentOffer, WalletConfig } from "@intentic/sandbox-contract";
import { type CardDeps, cardRun, OFFER_DEADLINE_MS, raiseCard, type SettledCard, whyOf } from "../agent/run/offer-card.js";
import type { RelayedAnswer } from "../platform/platform-relay.js";
import type { SignRequest } from "./wallet-signer.js";
import { type OpenedPayment, spentTodayAtomic, type WalletLedgerStore } from "./wallet-ledger.js";
import {
    atomicToUsd,
    mintAuthorization,
    parseChallenge,
    parseSettlement,
    paymentHeader,
    type PaymentQuote,
    usdcNetworkOf,
    usdToAtomic,
} from "./x402.js";

// Unpaid probe, parse the 402 challenge, check policy, raise an offer card whose numbers are the challenge's and the
// ledger's, never the model's (except `why`); only a click or the auto-approve band releases a signature.
// Raised outside the turn generator (the CLI call is HTTP while the turn sits in Bash): frames go to the live run's
// log, and the card is never journalled, its waiter is the CLI's held connection.
// An approval releases one EIP-3009 authorization, signed by the platform and settled by the merchant; a failure after
// signing spends nothing, since the authorization just expires unused.

// The unpaid probe's budget: long enough for a slow challenge, short enough not to hold the CLI hostage.
const PROBE_TIMEOUT_MS = 60_000;
// The paid retry's budget: the actual work runs now, plus onchain settlement.
const RETRY_TIMEOUT_MS = 300_000;

const refusal = (status: number, type: string, message: string): RelayedAnswer => ({
    status,
    body: JSON.stringify({ error: { type, message } }),
    contentType: "application/json",
});

export interface PaidAnswer extends RelayedAnswer {
    // Present only when a payment settled with this answer; what the CLI's receipt line renders.
    readonly paidUsd?: string;
    readonly transaction?: string;
}

export interface PaymentGateDeps extends CardDeps {
    // The wallet capability's live config, read fresh per call so a policy edit applies to the next payment.
    readonly wallet: () => Promise<WalletConfig | undefined>;
    readonly ledger: WalletLedgerStore;
    // The platform signer relay (wallet-signer.ts), injected so tests drive the gate without a platform.
    readonly sign: (request: SignRequest) => Promise<RelayedAnswer>;
    readonly fetchFn?: typeof fetch;
    // Whether the turn has read outside content (guard/turn-taint.ts); the one non-policy input to auto-approve.
    readonly tainted: (conversationId: string) => boolean;
    readonly deadlineMs?: number;
    readonly now?: () => number;
}

export interface PaidFetchRequest {
    readonly url: string;
    readonly method: string;
    readonly body: string | undefined;
    readonly contentType: string | undefined;
    // The agent's own ceiling for this call; narrows the owner's bound, never raises it.
    readonly maxUsd: string | undefined;
    readonly why: string | undefined;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

const hostsOf = (list: string | undefined): readonly string[] =>
    (list ?? "")
        .split(/[\n,]/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== "");

// Suffix match on dot boundaries: "example.com" covers "api.example.com", never "notexample.com".
const hostMatches = (host: string, entry: string): boolean => host === entry || host.endsWith(`.${entry}`);

const USD_RE = /^\d+(\.\d{1,6})?$/;

export const gatedPaidFetch = async (deps: PaymentGateDeps, request: PaidFetchRequest): Promise<PaidAnswer> => {
    const fetchFn = deps.fetchFn ?? fetch;
    const now = deps.now ?? Date.now;
    const config = await deps.wallet();
    if (config === undefined) {
        return refusal(
            409,
            "no_wallet",
            'This sandbox has no wallet. Ask the owner to connect one: `capabilities request wallet --why "..."`, nothing can be paid until they do.',
        );
    }
    if (config.address === undefined || config.address === "") {
        return refusal(409, "wallet_pending", "The wallet is added but not finished setting up: its address has not arrived from the platform yet.");
    }
    const network = usdcNetworkOf(config.network);
    if (network === undefined) {
        return refusal(409, "wallet_misconfigured", `The wallet names an unsupported network (${config.network}).`);
    }
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return refusal(400, "invalid_request", `Not a URL: ${request.url.slice(0, 200)}`);
    }
    if (url.protocol !== "https:") {
        return refusal(400, "invalid_request", "Payments ride only https URLs: a challenge over plain http could be anyone's.");
    }
    if (request.maxUsd !== undefined && !USD_RE.test(request.maxUsd)) {
        return refusal(400, "invalid_request", `--max wants a USD amount like 0.50, got: ${request.maxUsd.slice(0, 40)}`);
    }
    const host = url.hostname.toLowerCase();

    // The unpaid probe: the agent's request sent without payment. A non-402 answer passes through whole; a free
    // endpoint or the endpoint's own 4xx/5xx ends here.
    const requestInit = (extra?: Record<string, string>): RequestInit => ({
        method: request.method,
        headers: {
            ...(request.contentType !== undefined ? { "content-type": request.contentType } : {}),
            ...extra,
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
    });
    let probe: Response;
    let probeBody: string;
    try {
        probe = await fetchFn(url, { ...requestInit(), signal: AbortSignal.any([request.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) });
        probeBody = await probe.text();
    } catch (error) {
        return refusal(502, "unreachable", `The endpoint could not be reached (${error instanceof Error ? error.message : "network error"}), nothing was spent.`);
    }
    if (probe.status !== 402) {
        return { status: probe.status, body: probeBody, contentType: probe.headers.get("content-type") ?? "application/json" };
    }

    const challenge = parseChallenge(request.url, probe.headers, probeBody);
    if (challenge.kind === "unsupported") {
        return refusal(502, "unsupported_protocol", `${challenge.reason}: nothing was spent.`);
    }
    if (challenge.kind === "none") {
        // A 402 that isn't a machine-payable challenge is the endpoint's own refusal, relayed whole.
        return { status: 402, body: probeBody, contentType: probe.headers.get("content-type") ?? "application/json" };
    }
    const quote: PaymentQuote | undefined = challenge.quotes.find(
        (candidate) => candidate.network === config.network && candidate.asset.toLowerCase() === network.asset.toLowerCase(),
    );
    if (quote === undefined) {
        const offered = challenge.quotes.map((candidate) => `${candidate.network} ${candidate.asset}`).join(", ");
        return refusal(
            409,
            "no_matching_rail",
            `The endpoint charges on rails this wallet does not hold: it accepts [${offered}], the wallet pays USDC on ${network.label} (${config.network}). Nothing was spent.`,
        );
    }

    // Every ceiling here is the owner's own number from the capability card (or the agent's `--max`, which may only
    // narrow); amounts compare in atomic units. Refusals name the number that stopped them.
    const amountUsd = atomicToUsd(quote.amountAtomic);
    const opened: OpenedPayment = {
        url: request.url,
        host,
        payTo: quote.payTo,
        network: config.network,
        amountUsd,
        auto: false,
        why: request.why,
    };
    if (hostsOf(config.deny).some((entry) => hostMatches(host, entry))) {
        await deps.ledger.record(opened, "refused");
        return refusal(403, "denied_host", `${host} is on the wallet's deny list: nothing was spent.`);
    }
    if (quote.amountAtomic > usdToAtomic(config.perPaymentMaxUsd)) {
        await deps.ledger.record(opened, "refused");
        return refusal(
            403,
            "over_payment_cap",
            `This costs $${amountUsd}, over the wallet's per-payment ceiling of $${config.perPaymentMaxUsd}. Nothing was spent; the owner can raise the ceiling on the wallet card.`,
        );
    }
    if (request.maxUsd !== undefined && quote.amountAtomic > usdToAtomic(request.maxUsd)) {
        return refusal(403, "over_own_max", `This costs $${amountUsd}, over the $${request.maxUsd} ceiling you passed with --max. Nothing was spent.`);
    }
    const spentToday = spentTodayAtomic(await deps.ledger.all(), now(), usdToAtomic);
    const dailyCap = usdToAtomic(config.dailyCapUsd);
    if (spentToday + quote.amountAtomic > dailyCap) {
        await deps.ledger.record(opened, "refused");
        return refusal(
            403,
            "over_daily_cap",
            `This costs $${amountUsd}, and $${atomicToUsd(spentToday)} of the $${config.dailyCapUsd} daily cap is already spent or in flight. Nothing was spent; the cap resets at midnight UTC.`,
        );
    }

    // Inside the auto-approve band (and the allow list, if any), the owner's standing delegation covers the spend and
    // no card goes up; otherwise it parks on a card, and no live conversation means no card can go up at all.
    // The band is suspended on a tainted turn (outside content replaces the agent's own judgment): the payment still
    // happens, it just asks first.
    const allow = hostsOf(config.allow);
    const tainted = request.conversationId !== undefined && deps.tainted(request.conversationId);
    const auto =
        !tainted &&
        quote.amountAtomic <= usdToAtomic(config.autoApproveUnderUsd) &&
        (allow.length === 0 || allow.some((entry) => hostMatches(host, entry)));
    let card: SettledCard<"payment_offer"> | undefined;
    if (!auto) {
        const run = cardRun(deps, request.conversationId);
        if (run === undefined) {
            return refusal(
                409,
                "no_conversation",
                "A payment needs a live conversation to raise its approval card in, and none could be found. Nothing was spent.",
            );
        }
        const offer: PaymentOffer = {
            url: request.url,
            ...(quote.description !== undefined ? { description: quote.description } : {}),
            payTo: quote.payTo,
            network: config.network,
            asset: quote.asset,
            assetName: "USDC",
            amountUsd,
            spentTodayUsd: atomicToUsd(spentToday),
            dailyCapUsd: config.dailyCapUsd,
            ...whyOf(request.why),
        };
        card = await raiseCard(deps, run, {
            kind: "payment_offer",
            onAbort: { kind: "payment_offer", requestId: "", approve: false },
            raised: (requestId) => ({ kind: "payment_offer", requestId, offer }),
            signal: request.signal,
            deadlineMs: deps.deadlineMs ?? OFFER_DEADLINE_MS,
        });
        if (!card.reply.approve) {
            // Two different refusals, told apart by whether a person actually answered.
            if (!card.answered) {
                await deps.ledger.record(opened, "unanswered");
                return refusal(408, "unanswered", "The payment offer went unanswered and expired: nothing was spent. Continue without it; offer again only if the owner shows up.");
            }
            await deps.ledger.record(opened, "declined");
            return refusal(403, "declined", "The owner skipped this payment: nothing was spent. Continue without it.");
        }
    }

    // Opens a pending row first (an unwritable ledger fails closed; the row holds the amount against the cap while in
    // flight), then signs, then retries with payment. A failure after signing spends nothing: the authorization expires
    // unused.
    let rowId: string;
    try {
        rowId = await deps.ledger.open({ ...opened, auto });
    } catch {
        return refusal(500, "ledger_unwritable", "The wallet ledger could not be written, so the payment was refused: no spend without a record.");
    }
    const receipt = (outcome: "paid" | "failed", transaction?: string): void => {
        if (card === undefined) {
            return;
        }
        card.say({
            kind: "payment_receipt",
            requestId: card.requestId,
            outcome,
            amountUsd,
            ...(transaction !== undefined ? { transaction } : {}),
            network: config.network,
        });
    };
    const authorization = mintAuthorization(quote, config.address, now());
    const signed = await deps.sign({
        network: config.network,
        asset: quote.asset,
        domainName: quote.domainName,
        domainVersion: quote.domainVersion,
        authorization,
        amountUsd,
        host,
    });
    if (signed.status !== 200) {
        await deps.ledger.settle(rowId, "refused");
        receipt("failed");
        return { ...refusal(signed.status === 502 ? 502 : 403, "signer_refused", `The platform declined to sign: ${signed.body.slice(0, 300)}, nothing was spent.`) };
    }
    let signature: string;
    try {
        const parsed = JSON.parse(signed.body) as { signature?: unknown };
        if (typeof parsed.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(parsed.signature)) {
            throw new Error("no signature");
        }
        signature = parsed.signature;
    } catch {
        await deps.ledger.settle(rowId, "refused");
        receipt("failed");
        return refusal(502, "signer_broken", "The platform's signing answer was unreadable: nothing was spent.");
    }
    const header = paymentHeader(quote, authorization, signature);
    let paid: Response;
    let paidBody: string;
    try {
        paid = await fetchFn(url, {
            ...requestInit({ [header.name]: header.value }),
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(RETRY_TIMEOUT_MS)]),
        });
        paidBody = await paid.text();
    } catch (error) {
        // The retry died before an answer arrived; the row stays pending until the authorization ages out on its own.
        receipt("failed");
        return refusal(
            502,
            "settlement_unknown",
            `The endpoint stopped answering after the payment was sent (${error instanceof Error ? error.message : "network error"}). The authorization expires within minutes if unsettled; check \`wallet history\` and the owner's balance before retrying.`,
        );
    }
    const settlement = parseSettlement(paid.headers);
    const served = paid.status >= 200 && paid.status < 300 && settlement?.success !== false;
    if (!served) {
        await deps.ledger.settle(rowId, "failed");
        receipt("failed");
        const reason = settlement?.errorReason ?? `the endpoint answered ${paid.status} to the paid retry`;
        return refusal(502, "payment_failed", `Payment failed: ${reason}, the authorization expires unused, nothing was spent. Response: ${paidBody.slice(0, 300)}`);
    }
    await deps.ledger.settle(rowId, "paid", settlement?.transaction);
    receipt("paid", settlement?.transaction);
    return {
        status: paid.status,
        body: paidBody,
        contentType: paid.headers.get("content-type") ?? "application/json",
        paidUsd: amountUsd,
        ...(settlement?.transaction !== undefined ? { transaction: settlement.transaction } : {}),
    };
};
