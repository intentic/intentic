import type { WalletPolicy } from "@intentic/api-contract";
import { WalletConfigSchema } from "@intentic/sandbox-contract";
import { apiClient } from "../../../lib/useApi";

/* THE WALLET CARD'S CAPS GO TO THE PLATFORM FROM HERE, the browser the owner is signed into, and from nowhere else. */
export const walletPolicyOf = (config: Readonly<Record<string, string>>): WalletPolicy => {
    const wallet = WalletConfigSchema.parse(config);
    return { network: wallet.network, perPaymentMaxUsd: wallet.perPaymentMaxUsd, dailyCapUsd: wallet.dailyCapUsd };
};

export const pushWalletPolicy = async (config: Readonly<Record<string, string>>): Promise<void> => {
    await apiClient.wallet.setPolicy(walletPolicyOf(config));
};
