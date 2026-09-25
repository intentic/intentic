import type { WalletConfig } from "@intentic/sandbox-contract";
import { atomicToUsd, usdcNetworkOf, usdToAtomic } from "@intentic/sandbox-contract/x402";
import type { Context } from "hono";
import { cardDeps } from "../conversations/actor/card-offers.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { answerResponse, cliBody } from "../http/cli-answer.js";
import { conversationTainted } from "../guard/turn-taint.js";
import { gatedPaidFetch } from "./payment-offer.js";
import { relayWalletSign } from "./wallet-signer.js";
import { spentTodayAtomic } from "./wallet-ledger.js";
import { usdcBalance } from "./x402.js";

/* Wallet routes are scoped to the agent token. */

const walletEntry = async (services: Services): Promise<WalletConfig | undefined> => {
    const entry = (await services.capabilities.list()).find((capability) => capability.kind === "wallet");
    return entry?.kind === "wallet" ? entry.config : undefined;
};

export const createWalletRoutes = (services: Services) => ({
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
            network !== undefined && config.address !== undefined && config.address !== ""
                ? await usdcBalance(network, config.address)
                : undefined;
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
        const { url, method, body: payload, contentType, maxUsd, why } = body;
        if (typeof url !== "string" || url === "") {
            return c.json({ error: { type: "invalid_request", message: "`url` names the endpoint to fetch (and pay, if it asks)" } }, 400);
        }
        const answer = await gatedPaidFetch(
            {
                wallet: () => walletEntry(services),
                ledger: services.walletLedger,
                sign: (request) => relayWalletSign(services.config, request),
                ...cardDeps(services),
                tainted: conversationTainted,
            },
            {
                url,
                method: typeof method === "string" && method !== "" ? method.toUpperCase() : "GET",
                body: typeof payload === "string" ? payload : undefined,
                contentType: typeof contentType === "string" ? contentType : undefined,
                maxUsd: typeof maxUsd === "string" && maxUsd !== "" ? maxUsd : undefined,
                why: typeof why === "string" && why !== "" ? why : undefined,
                conversationId: c.req.header("x-intentic-conversation"),
                signal: c.req.raw.signal,
            },
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
