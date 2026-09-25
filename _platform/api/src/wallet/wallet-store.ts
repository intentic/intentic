import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { CustodyGateway } from "./wallet-custody.js";

/* The wallet row is shared by sandbox funding and owner signing. */

export interface WalletRow {
    readonly id: string;
    readonly address: string;
    readonly perPaymentMaxUsd: string;
    readonly dailyCapUsd: string;
}

const select = { id: true, address: true, perPaymentMaxUsd: true, dailyCapUsd: true } as const;

/* ONE WALLET PER ACCOUNT AND NETWORK, created on first ask with the schema's own default caps. */
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
