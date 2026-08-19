import type { WalletConfig } from "@intentic/sandbox-contract";
import { atomicToUsd, usdcBalance, usdcNetworkOf } from "../../wallet/x402.js";
import type { CapabilityHandler } from "../capability.js";

/* THE SANDBOX WALLET's handler — the card half of a feature whose money half lives elsewhere on purpose.
 *
 * `apply` asks the PLATFORM for this owner's wallet (one per owner, created on first ask) and writes the
 * answered ADDRESS back into the manifest entry — the address is public and is the whole of what the
 * container ever holds; the signing key stays with the platform, reached only through the connect token
 * (wallet/wallet-signer.ts says why). The policy caps ride along on every apply, so editing the card is how
 * an owner changes what the SIGNER will enforce, not just what the daemon checks.
 *
 * A failed ensure is NOT fatal, the endpoint handler's reasoning verbatim: the entry stores either way and
 * the card carries the truth (`pending`), because the ordinary failure is a platform that has wallet signing
 * unconfigured — a fact for the card to state, not a reason to throw away the policy the owner just set.
 *
 * `remove` is a disconnect, not a burn: the wallet and its funds stay with the platform under the owner's
 * account (re-adding the card finds the same address), because a capability removal must never be the thing
 * that strands money. */

const policyOf = (config: WalletConfig): { perPaymentMaxUsd: string; dailyCapUsd: string } => ({
    perPaymentMaxUsd: config.perPaymentMaxUsd,
    dailyCapUsd: config.dailyCapUsd,
});

export const walletHandler: CapabilityHandler = {
    // No secret: the config is an address and the owner's own policy numbers, all of it printable.
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
    // Nothing is keyed by the name: the ledger is the sandbox's, the wallet is the owner's, the CLI takes no
    // id. The re-apply re-asks the platform, which answers the same address.
    rename: {},
    apply: async function* (ctx, id, config) {
        const wallet = config as WalletConfig;
        const network = usdcNetworkOf(wallet.network);
        yield { kind: "log", message: `Asking the platform for this owner's wallet on ${network?.label ?? wallet.network}…` };
        const answer = await ctx.walletEnsure(wallet.network, policyOf(wallet));
        if (answer.status !== 200) {
            yield {
                kind: "log",
                message: `The platform could not provide a wallet yet (${answer.body.slice(0, 200)}). The card stays pending — edit or re-add it to retry.`,
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
            yield { kind: "log", message: "The platform's wallet answer was unreadable. The card stays pending — re-add it to retry." };
            return;
        }
        if (wallet.address !== address) {
            await ctx.capabilities.upsert({ id, kind: "wallet", config: { ...wallet, address } });
        }
        yield { kind: "log", message: `Wallet ready: ${address} on ${network?.label ?? wallet.network}.` };
        yield {
            kind: "log",
            message: `Fund it by sending USDC (on ${network?.label ?? wallet.network} — the network matters) to that address. The agent pays with \`wallet fetch\`, under the card's caps; every payment above the auto-approve band asks in chat first.`,
        };
    },
    status: async (_ctx, _id, config) => {
        const wallet = config as WalletConfig;
        if (wallet.address === undefined || wallet.address === "") {
            return { state: "pending", detail: "waiting for the platform's wallet — edit or re-add the card to retry" };
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
