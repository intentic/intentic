import type { WalletConfig } from "@intentic/sandbox-contract";
import { atomicToUsd, usdcNetworkOf } from "@intentic/sandbox-contract/x402";
import { usdcBalance } from "../../wallet/x402.js";
import type { CapabilityHandler } from "../capability.js";

/* THE SANDBOX WALLET's handler, the entry half of a feature whose money half lives elsewhere on purpose. */

export const walletHandler: CapabilityHandler = {
    // No secret: the config is an address and the owner's own policy numbers, all printable.
    echo: (config) => {
        const wallet = config as WalletConfig;
        return {
            network: wallet.network,
            address: wallet.address ?? "",
            perPaymentMaxUsd: wallet.perPaymentMaxUsd,
            autoApproveUnderUsd: wallet.autoApproveUnderUsd,
            dailyCapUsd: wallet.dailyCapUsd,
            ...(wallet.allow !== undefined ? { allow: wallet.allow } : {}),
            ...(wallet.deny !== undefined ? { deny: wallet.deny } : {}),
        };
    },
    // Nothing is keyed by the name (the CLI takes no id); a re-apply re-asks the platform for the same address.
    rename: {},
    async *apply(ctx, id, config) {
        const wallet = config as WalletConfig;
        const network = usdcNetworkOf(wallet.network);
        yield { kind: "log", message: `Asking the platform for this owner's wallet on ${network?.label ?? wallet.network}…` };
        const answer = await ctx.walletEnsure(wallet.network);
        if (answer.status !== 200) {
            yield {
                kind: "log",
                message: `The platform could not provide a wallet yet (${answer.body.slice(0, 200)}). The entry stays pending, edit or re-add it to retry.`,
            };
            return;
        }
        let address: string | undefined;
        try {
            const parsed = JSON.parse(answer.body) as { address?: unknown };
            address = typeof parsed.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(parsed.address) ? parsed.address : undefined;
        } catch {
            address = undefined;
        }
        if (address === undefined) {
            yield { kind: "log", message: "The platform's wallet answer was unreadable. The entry stays pending, re-add it to retry." };
            return;
        }
        if (wallet.address !== address) {
            await ctx.capabilities.upsert({ id, kind: "wallet", config: { ...wallet, address } });
        }
        yield { kind: "log", message: `Wallet ready: ${address} on ${network?.label ?? wallet.network}.` };
        yield {
            kind: "log",
            message: `Fund it by sending USDC (on ${network?.label ?? wallet.network}, the network matters) to that address. The agent pays with \`wallet fetch\`, under the entry's caps; every payment above the auto-approve band asks in chat first.`,
        };
    },
    status: async (_ctx, _id, config) => {
        const wallet = config as WalletConfig;
        if (wallet.address === undefined || wallet.address === "") {
            return { state: "pending", detail: "waiting for the platform's wallet, edit or re-add the entry to retry" };
        }
        const network = usdcNetworkOf(wallet.network);
        if (network === undefined) {
            return { state: "error", detail: `unsupported network ${wallet.network}` };
        }
        const balance = await usdcBalance(network, wallet.address);
        return balance === undefined
            ? { state: "active", detail: `${network.label} · balance unavailable right now` }
            : { state: "active", detail: `$${atomicToUsd(balance)} USDC on ${network.label}` };
    },
    remove: async () => {},
};
