import { apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { type CustodyGateway, custodyGateway, walletEnabled } from "./wallet-custody.js";
import { ensureWallet } from "./wallet-store.js";

const os = implement(apiContract).$context<OrpcContext>();

/* wallet.routes.ts states why the signer re-checks the caps on every signature: the container is not a trust boundary. */
export const walletRoutes = (custody?: CustodyGateway) => ({
    setPolicy: os.wallet.setPolicy.handler(async ({ context, input }) => {
        const user = requireUser(context);
        if (!walletEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: `wallet signing is not enabled on this platform` });
        }
        const wallet = await ensureWallet(context.prisma, custody ?? custodyGateway(context.config), user.id, input.network);
        const updated = await context.prisma.wallet.update({
            where: { id: wallet.id },
            data: { perPaymentMaxUsd: input.perPaymentMaxUsd, dailyCapUsd: input.dailyCapUsd },
            select: { perPaymentMaxUsd: true, dailyCapUsd: true },
        });
        return { network: input.network, perPaymentMaxUsd: updated.perPaymentMaxUsd, dailyCapUsd: updated.dailyCapUsd };
    }),
});
