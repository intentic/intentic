import type { WalletConfig } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { soleLiveConversation, turnRunOf } from "../agent/turn-runs.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { conversationTainted } from "../guard/turn-taint.js";
import { gatedPaidFetch } from "./payment-offer.js";
import { relayWalletSign } from "./wallet-signer.js";
import { spentTodayAtomic } from "./wallet-ledger.js";
import { atomicToUsd, usdcBalance, usdcNetworkOf, usdToAtomic } from "./x402.js";

/* The `wallet` CLI's three routes — the agent-facing surface of the sandbox wallet, scoped to the agent
 * token in auth/grants.ts like `services` and `capabilities`.
 *
 * `status` and `history` are reads an agent plans around: what the wallet holds, what today's budget has
 * left, what was paid and to whom. `fetch` is the one door money can leave through, and the whole consent
 * story lives behind it (wallet/payment-offer.ts): the daemon makes the request, parses the endpoint's own
 * 402, checks the owner's policy, raises the card, signs at the platform, retries, and answers with the paid
 * response. Nothing here reads a key, because the container never holds one. */

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
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: { type: "invalid_request", message: 'the fetch body must be JSON: {"url":"https://…", …}' } }, 400);
        }
        const { url, method, body: payload, contentType, maxUsd, why } = (body ?? {}) as Record<string, unknown>;
        if (typeof url !== "string" || url === "") {
            return c.json({ error: { type: "invalid_request", message: "`url` names the endpoint to fetch (and pay, if it asks)" } }, 400);
        }
        const answer = await gatedPaidFetch(
            {
                wallet: () => walletEntry(services),
                ledger: services.walletLedger,
                sign: (request) => relayWalletSign(services.config, request),
                liveRun: (conversationId) => {
                    const id = conversationId ?? soleLiveConversation();
                    const run = id === undefined ? undefined : turnRunOf(id);
                    return id === undefined || run === undefined || run.done ? undefined : { conversationId: id, push: (event) => run.push(event) };
                },
                observe: (conversationId, event) => services.agents.observe(conversationId, event),
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
        return c.newResponse(answer.body, answer.status as 200, {
            "content-type": answer.contentType,
            // The receipt facts ride headers so the CLI can print data on stdout and the receipt on stderr.
            ...(answer.paidUsd !== undefined ? { "x-intentic-paid-usd": answer.paidUsd } : {}),
            ...(answer.transaction !== undefined ? { "x-intentic-paid-tx": answer.transaction } : {}),
        });
    },
    history: async (c: Context<AppEnv>): Promise<Response> => {
        const rows = await services.walletLedger.all();
        return c.json({ payments: rows.slice(-50).toReversed() });
    },
});
