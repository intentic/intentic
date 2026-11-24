import type { WalletConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { atomicToUsd, usdcNetworkOf, usdToAtomic } from "@intentic/sandbox-contract/x402";
import type { Context } from "hono";
import { cardDeps } from "../conversations/actor/card-deps.js";
import { turnRunOf } from "../conversations/actor/conversation-holdings.js";
import { holdDepsOf } from "../guard/held-asks.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { answerResponse, cliBody } from "../http/cli-answer.js";
import { conversationTainted } from "../guard/turn-taint.js";
import { gatedPaidFetch, type PaidFetchRequest } from "./payment-offer.js";
import { relayWalletSign } from "./wallet-signer.js";
import { spentTodayAtomic } from "./wallet-ledger.js";
import { usdcBalance } from "./x402.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { turnClaimOf, unprovenTurnWords } from "../seams/workload-stamp.js";

/* Wallet routes are scoped to the agent token. */

const walletEntry = async (services: Services): Promise<WalletConfig | undefined> => {
    const entry = (await services.capabilities.list()).find((capability) => capability.kind === "wallet");
    return entry?.kind === "wallet" ? entry.config : undefined;
};

// The body as cliBody parsed it: still the CLI's words, every field read and checked below.
type CliBody = Exclude<Awaited<ReturnType<typeof cliBody>>, Response>;

// What a CLI's `fetch` asks for, its optional fields read loosely (one of the wrong type is one not given), or the
// refusal to answer with. The conversation the card goes to and whose taint is read is believed only with its turn's
// proof: a name without it is refused rather than spend as that conversation, and naming none asks the owner
// (payment-offer.ts).
const paidFetchRequestOf = (c: Context<AppEnv>, body: CliBody): PaidFetchRequest | Response => {
    const { url, method, body: payload, contentType, maxUsd, why } = body;
    if (typeof url !== "string" || url === "") {
        return c.json({ error: { type: "invalid_request", message: "`url` names the endpoint to fetch (and pay, if it asks)" } }, 400);
    }
    const claim = turnClaimOf((name) => c.req.header(name));
    if (claim.kind === "unproven") {
        return c.json({ error: { type: "unproven", message: unprovenTurnWords(claim.named) } }, 403);
    }
    return {
        url,
        method: typeof method === "string" && method !== "" ? method.toUpperCase() : "GET",
        body: typeof payload === "string" ? payload : undefined,
        contentType: typeof contentType === "string" ? contentType : undefined,
        maxUsd: typeof maxUsd === "string" && maxUsd !== "" ? maxUsd : undefined,
        why: typeof why === "string" && why !== "" ? why : undefined,
        conversationId: claim.kind === "proven" ? claim.conversationId : undefined,
        signal: c.req.raw.signal,
    };
};

const createWalletRoutes = (services: Services) => ({
    status: async (c: Context<AppEnv>): Promise<Response> => {
        const config = await walletEntry(services);
        if (config === undefined) {
            return c.json({
                connected: false,
                hint: 'No wallet is connected. Ask the owner for one with `capabilities request wallet --why "..."`.',
            });
        }
        const network = usdcNetworkOf(config.network);
        const rows = await services.walletLedger.all();
        const spent = spentTodayAtomic(rows, Date.now(), usdToAtomic);
        const cap = usdToAtomic(config.dailyCapUsd);
        const balance =
            network !== undefined && config.address !== undefined && config.address !== "" ? await usdcBalance(network, config.address) : undefined;
        return c.json({
            connected: true,
            address: config.address ?? null,
            network: config.network,
            networkLabel: network?.label ?? config.network,
            ...(balance !== undefined ? { balanceUsd: atomicToUsd(balance) } : {}),
            policy: {
                perPaymentMaxUsd: config.perPaymentMaxUsd,
                autoApproveUnderUsd: config.autoApproveUnderUsd,
                dailyCapUsd: config.dailyCapUsd,
                ...(config.allow !== undefined ? { allow: config.allow } : {}),
                ...(config.deny !== undefined ? { deny: config.deny } : {}),
            },
            spentTodayUsd: atomicToUsd(spent),
            remainingTodayUsd: atomicToUsd(spent >= cap ? 0n : cap - spent),
        });
    },
    fetch: async (c: Context<AppEnv>): Promise<Response> => {
        const body = await cliBody(c, "fetch", '{"url":"https://…", …}');
        if (body instanceof Response) {
            return body;
        }
        const asked = paidFetchRequestOf(c, body);
        if (asked instanceof Response) {
            return asked;
        }
        const answer = await gatedPaidFetch(
            {
                wallet: () => walletEntry(services),
                ledger: services.walletLedger,
                sign: (request) => relayWalletSign(services.config, request),
                ...cardDeps(services),
                hold: holdDepsOf(services.heldCards, (conversationId) => turnRunOf(services.conversations, conversationId)),
                tainted: conversationTainted,
                // Only where people sign in: a loopback daemon's replies carry nobody, and its one person answers.
                ...(services.auth !== undefined ? { ownerEmail: services.ownerEmail } : {}),
            },
            asked,
        );
        // The receipt facts ride headers so the CLI can print data on stdout and the receipt on stderr.
        return answerResponse(c, answer, {
            ...(answer.paidUsd !== undefined ? { "x-intentic-paid-usd": answer.paidUsd } : {}),
            ...(answer.transaction !== undefined ? { "x-intentic-paid-tx": answer.transaction } : {}),
        });
    },
    history: async (c: Context<AppEnv>): Promise<Response> => {
        const rows = await services.walletLedger.all();
        return c.json({ payments: rows.slice(-50).toReversed() });
    },
});

// The wallet surface: `status`/`history` are reads, `fetch` is the one door money leaves through.
// It parses the endpoint's x402 challenge, checks the owner's policy, parks non-standing spend on an approval card,
// and has the platform sign; the key never enters this container.
export const walletRawRoutes = defineRawRoutes((services: Services) => {
    const walletRoutes = createWalletRoutes(services);
    return {
        "GET /wallet/status": walletRoutes.status,
        "POST /wallet/fetch": walletRoutes.fetch,
        "GET /wallet/history": walletRoutes.history,
    };
});
