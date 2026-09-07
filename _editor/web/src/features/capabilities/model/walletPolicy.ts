import type { WalletPolicy } from "@intentic/api-contract";
import { WalletConfigSchema } from "@intentic/sandbox-contract";
import { apiClient } from "../../../lib/useApi";

/* THE WALLET CARD'S CAPS GO TO THE PLATFORM FROM HERE, the browser the owner is signed into, and from nowhere
 * else. The card's numbers ride to the daemon with the rest of its config, for the sandbox's own pre-check and
 * the words on its ledger; the copy the SIGNER enforces is the platform's, and the container is the one party
 * that must not write it — a sandbox that can set its own ceiling has none, and its ensure used to set it. So a
 * saved wallet card is two writes: the daemon's upsert, then this, over the session the daemon does not hold.
 *
 * Parsed through the daemon's own schema so a blank box means the same default on both sides: what the card
 * shows and what the signer holds are the same two numbers, or the reader is being shown a limit that is not
 * the one in force. */
export const walletPolicyOf = (config: Readonly<Record<string, string>>): WalletPolicy => {
    const wallet = WalletConfigSchema.parse(config);
    return { network: wallet.network, perPaymentMaxUsd: wallet.perPaymentMaxUsd, dailyCapUsd: wallet.dailyCapUsd };
};

export const pushWalletPolicy = async (config: Readonly<Record<string, string>>): Promise<void> => {
    await apiClient.wallet.setPolicy(walletPolicyOf(config));
};
