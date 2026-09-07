import { apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { type CustodyGateway, custodyGateway, walletEnabled } from "./wallet-custody.js";
import { ensureWallet } from "./wallet-store.js";

const os = implement(apiContract).$context<OrpcContext>();

/* THE CAPS, WRITTEN FROM THE OWNER'S SESSION AND FROM NOWHERE ELSE.
 *
 * wallet.routes.ts states why the signer re-checks the caps on every signature: the container is not a trust
 * boundary, so the number that binds must be one the platform holds. That argument was hollow while the same
 * container could WRITE the number, which /wallet/ensure let it do, over the connect token the daemon holds in
 * its env: a compromised sandbox raised its own ceiling to a million dollars and then asked for a signature
 * under it. The connect token is a credential the sandbox holds; a session is one only the owner's browser
 * holds. So the caps come in here, from the editor, when the owner saves the wallet card, and the sandbox's
 * ensure is left with the one thing it legitimately needs, an address.
 *
 * Creates the wallet when the account has none on that network, so the caps can be set before the sandbox ever
 * asks; a wallet the sandbox created first is found and updated. Answers the policy as stored. */
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
