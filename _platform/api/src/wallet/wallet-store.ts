import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { CustodyGateway } from "./wallet-custody.js";

/* THE WALLET ROW, shared by the two doors that can bring one into being: the sandbox's ensure (an address to
 * fund, over the connect token) and the owner's policy write (caps to hold it to, over a session). Either may
 * be first, and both must find the same wallet. */

// The chains this signer will mint for, and the token it will mint for on each, the compliance surface as a
// lookup: USDC only, `exact` scheme only, so every signature is a fixed-amount transfer of a dollar-pegged
// token the owner's caps are honestly written in.
export const NETWORKS: Record<string, { readonly chainId: number; readonly asset: string }> = {
    "eip155:8453": { chainId: 8453, asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` },
    "eip155:84532": { chainId: 84532, asset: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` },
};

export interface WalletRow {
    readonly id: string;
    readonly address: string;
    readonly perPaymentMaxUsd: string;
    readonly dailyCapUsd: string;
}

const select = { id: true, address: true, perPaymentMaxUsd: true, dailyCapUsd: true } as const;

/* ONE WALLET PER ACCOUNT AND NETWORK, created on first ask with the schema's own default caps. `reference` is
 * the platform's stable id for member+network, which is what makes the provider's create idempotent (a retried
 * ensure returns the same wallet rather than minting a second one the owner would then have to fund twice), and
 * the row's unique key makes ours: a creator that loses the race to the other door reads the row it lost to. */
export const ensureWallet = async (prisma: PrismaClient, gateway: CustodyGateway, ownerId: string, network: string): Promise<WalletRow> => {
    const key = { userId_network: { userId: ownerId, network } };
    const existing = await prisma.wallet.findUnique({ where: key, select });
    if (existing !== null) {
        return existing;
    }
    const created = await gateway.wallet(`${ownerId}:${network}`, network);
    try {
        return await prisma.wallet.create({ data: { userId: ownerId, network, address: created.address, providerWalletId: created.id }, select });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === `P2002`) {
            return prisma.wallet.findUniqueOrThrow({ where: key, select });
        }
        throw error;
    }
};
