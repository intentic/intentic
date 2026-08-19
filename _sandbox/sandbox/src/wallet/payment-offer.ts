import type { AgentEvent, PaymentOffer, WalletConfig } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import { DAEMON_OWNER, ONE_SHOT_OWNER } from "../platform/leftovers.js";
import type { RelayedAnswer } from "../platform/pool-services.js";
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

/* THE PAYMENT GATE — the services spend gate's shape (platform/service-offer.ts), pointed at the open x402
 * web instead of the platform's catalog. The agent's `wallet fetch` PARKS here: the daemon makes the unpaid
 * request itself, parses the endpoint's own 402 challenge, checks the owner's policy, raises an offer card
 * whose every number is the daemon's arithmetic over that challenge and the wallet's ledger (never anything
 * the model typed — the model owns the URL, the request body, and one line of why), and only the owner's
 * click (or the owner's standing auto-approve band) releases a signature. One click pays exactly one price —
 * a repeat parks a fresh card. A prompt-injected model can ask; it cannot spend.
 *
 * Raised OUTSIDE the turn generator for the services gate's reason verbatim: the CLI call arrives as an HTTP
 * request while the turn sits inside its Bash tool, so frames are pushed into the live run's frame log and
 * mirrored to the registry by hand, and the card is deliberately not journalled — its waiter is the CLI's
 * held connection, which dies with the daemon.
 *
 * WHAT AN APPROVAL RELEASES is one EIP-3009 authorization: a signed instruction for one transfer of one
 * exact amount to one recipient, expiring within five minutes, signed by the PLATFORM (the key never enters
 * this container) and settled by the merchant's own side. A payment that fails after signing spends nothing
 * — the authorization simply expires unused — which is why `failed` receipts can honestly say so. */

const OFFER_DEADLINE_MS = 10 * 60_000;
const WHY_MAX = 280;
// The unpaid probe's budget: enough for a slow endpoint's challenge, short enough that a dead one doesn't
// hold the CLI hostage.
const PROBE_TIMEOUT_MS = 60_000;
// The paid retry's budget — the request is doing the actual (possibly heavy) work now, plus onchain
// settlement (~2s on Base). Bounded like the services relay's stream budget.
const RETRY_TIMEOUT_MS = 300_000;

const refusal = (status: number, type: string, message: string): RelayedAnswer => ({
    status,
    body: JSON.stringify({ error: { type, message } }),
    contentType: "application/json",
});

export interface PaidAnswer extends RelayedAnswer {
    // Present when a payment actually settled with this answer — what the CLI's receipt line renders.
    readonly paidUsd?: string;
    readonly transaction?: string;
}

export interface PaymentGateDeps {
    // The wallet capability's live config, read fresh per call so a policy edit applies to the next payment.
    readonly wallet: () => Promise<WalletConfig | undefined>;
    readonly ledger: WalletLedgerStore;
    // The platform signer relay (wallet-signer.ts), injected so tests drive the gate without a platform.
    readonly sign: (request: SignRequest) => Promise<RelayedAnswer>;
    readonly fetchFn?: typeof fetch;
    // The live turn the card lands in — the service gate's own seam, verbatim.
    readonly liveRun: (
        conversationId: string | undefined,
    ) => { readonly conversationId: string; readonly push: (event: AgentEvent) => void } | undefined;
    readonly observe: (conversationId: string, event: AgentEvent) => void;
    // Whether the live turn in this conversation has taken in outside content (guard/turn-taint.ts) — the
    // one input to the auto-approve decision that is not the owner's policy. Injected like every other seam
    // so the gate's tests state the rule rather than reaching into a module registry.
    readonly tainted: (conversationId: string) => boolean;
    readonly deadlineMs?: number;
    readonly now?: () => number;
}

export interface PaidFetchRequest {
    readonly url: string;
    readonly method: string;
    readonly body: string | undefined;
    readonly contentType: string | undefined;
    // The agent's own ceiling for THIS call — a self-imposed bound below the owner's, never above it.
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
            'This sandbox has no wallet. Ask the owner to connect one: `capabilities request wallet --why "..."` — nothing can be paid until they do.',
        );
    }
    if (config.address === undefined || config.address === "") {
        return refusal(409, "wallet_pending", "The wallet is added but not finished setting up — its address has not arrived from the platform yet.");
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
        return refusal(400, "invalid_request", "Payments ride only https URLs — a challenge over plain http could be anyone's.");
    }
    if (request.maxUsd !== undefined && !USD_RE.test(request.maxUsd)) {
        return refusal(400, "invalid_request", `--max wants a USD amount like 0.50, got: ${request.maxUsd.slice(0, 40)}`);
    }
    const host = url.hostname.toLowerCase();

    /* THE UNPAID PROBE — the same request the agent asked for, sent without payment. A non-402 answer passes
     * through whole: a free endpoint stays free, an endpoint's own 4xx/5xx is its own business, and either
     * way nothing below this line runs. */
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
        return refusal(502, "unreachable", `The endpoint could not be reached (${error instanceof Error ? error.message : "network error"}) — nothing was spent.`);
    }
    if (probe.status !== 402) {
        return { status: probe.status, body: probeBody, contentType: probe.headers.get("content-type") ?? "application/json" };
    }

    const challenge = parseChallenge(request.url, probe.headers, probeBody);
    if (challenge.kind === "unsupported") {
        return refusal(502, "unsupported_protocol", `${challenge.reason} — nothing was spent.`);
    }
    if (challenge.kind === "none") {
        // A 402 that isn't a machine-payable challenge — the endpoint's own refusal, relayed whole.
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

    /* THE POLICY WALL — every check the card does not ask the owner to repeat. Amounts are compared in
     * atomic units; every ceiling here is the owner's own number off the capability card (or the agent's
     * `--max`, which may only narrow). Refusals name the number that stopped them, because the agent's next
     * move ("ask the owner to raise the cap", "give up") depends on which wall it was. */
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
        return refusal(403, "denied_host", `${host} is on the wallet's deny list — nothing was spent.`);
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

    /* THE CONSENT STEP. Inside the auto-approve band — and, when an allow list exists, only on its hosts —
     * the owner's standing delegation covers the spend and no card goes up. Everything else parks on a card;
     * no live conversation means no card CAN go up, and an unanswered card times out as exactly that. The
     * band's default is "0": out of the box, every payment is a click.
     *
     * THE BAND IS SUSPENDED ON A TAINTED TURN — one that has taken in content from outside (a fetched page,
     * a stranger's message; guard/turn-taint.ts). The delegation was granted for the AGENT's judgment about
     * small payments, and outside content is precisely what replaces that judgment: a page that can talk a
     * model into paying is a page that can be paid. So the payment still happens, it just asks first. This
     * is the command gate's credential floor, one door along and with money instead of secrets. */
    const allow = hostsOf(config.allow);
    const tainted = request.conversationId !== undefined && deps.tainted(request.conversationId);
    const auto =
        !tainted &&
        quote.amountAtomic <= usdToAtomic(config.autoApproveUnderUsd) &&
        (allow.length === 0 || allow.some((entry) => hostMatches(host, entry)));
    let requestId: string | undefined;
    let card: { readonly conversationId: string; readonly push: (event: AgentEvent) => void } | undefined;
    if (!auto) {
        const named =
            request.conversationId === DAEMON_OWNER || request.conversationId === ONE_SHOT_OWNER ? undefined : request.conversationId;
        card = deps.liveRun(named);
        if (card === undefined) {
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
            ...(request.why !== undefined && request.why !== "" ? { why: request.why.slice(0, WHY_MAX) } : {}),
        };
        const { id, wait } = createRequest("payment_offer", { kind: "payment_offer", requestId: "", approve: false }, card.conversationId);
        requestId = id;
        const raised: AgentEvent = { kind: "payment_offer", requestId: id, offer };
        card.push(raised);
        deps.observe(card.conversationId, raised);
        const { reply, resolved } = await wait(AbortSignal.any([request.signal, AbortSignal.timeout(deps.deadlineMs ?? OFFER_DEADLINE_MS)]));
        card.push(resolved);
        deps.observe(card.conversationId, resolved);
        if (!reply.approve) {
            // Two different no's, told apart the service gate's way: a resolved frame with no reply is the
            // deadline or a dead CLI, and reading it as "declined" would put words in the owner's mouth.
            if (resolved.reply === undefined) {
                await deps.ledger.record(opened, "unanswered");
                return refusal(408, "unanswered", "The payment offer went unanswered and expired — nothing was spent. Continue without it; offer again only if the owner shows up.");
            }
            await deps.ledger.record(opened, "declined");
            return refusal(403, "declined", "The owner skipped this payment — nothing was spent. Continue without it.");
        }
    }

    /* THE SPEND. A pending row FIRST — a ledger that cannot be written refuses the payment (fail closed, and
     * the pending row is what holds this amount against the daily cap while it is in flight). Then one
     * signature from the platform (which re-checks its own mirror of the caps), then the retry carrying the
     * payment header. A failure anywhere after signing spends nothing: the authorization expires unused. */
    let rowId: string;
    try {
        rowId = await deps.ledger.open({ ...opened, auto });
    } catch {
        return refusal(500, "ledger_unwritable", "The wallet ledger could not be written, so the payment was refused — no spend without a record.");
    }
    const receipt = (outcome: "paid" | "failed", transaction?: string): void => {
        if (requestId === undefined || card === undefined) {
            return;
        }
        const frame: AgentEvent = {
            kind: "payment_receipt",
            requestId,
            outcome,
            amountUsd,
            ...(transaction !== undefined ? { transaction } : {}),
            network: config.network,
        };
        card.push(frame);
        deps.observe(card.conversationId, frame);
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
        return { ...refusal(signed.status === 502 ? 502 : 403, "signer_refused", `The platform declined to sign: ${signed.body.slice(0, 300)} — nothing was spent.`) };
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
        return refusal(502, "signer_broken", "The platform's signing answer was unreadable — nothing was spent.");
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
        /* The one honest unknown: the retry died between sending the authorization and reading an answer.
         * The row stays `pending` — whether the merchant settled is theirs to know, the authorization
         * expires within its five-minute window either way, and the pending row keeps the amount held
         * against the daily cap until it ages out of today. */
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
        return refusal(502, "payment_failed", `Payment failed: ${reason} — the authorization expires unused, nothing was spent. Response: ${paidBody.slice(0, 300)}`);
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
