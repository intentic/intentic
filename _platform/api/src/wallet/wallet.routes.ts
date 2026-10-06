import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { atomicToUsd, USDC_NETWORKS, usdcNetworkOf, usdToAtomic } from "@intentic/sandbox-contract/x402";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { ingressServer } from "../ingress.js";
import { type CustodyGateway, custodyGateway, type TypedData, walletEnabled } from "./wallet-custody.js";
import { ensureWallet } from "./wallet-store.js";

/* These routes enforce the wallet release policy for sandbox agents. */

// The chains this signer mints on, USDC only: every signature is a fixed-amount transfer of the token the caps are written in.
const SIGNED_NETWORKS = USDC_NETWORKS.map(({ network }) => network).join(`, `);

// Validity ceiling: a signature is a bearer instrument until it expires; too long is refused, never trimmed.
const MAX_VALIDITY_S = 600;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

// The one refusal the cap transaction raises on purpose; anything else it throws is the database failing.
class DailyCapExceeded extends Error {}

export interface WalletDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injectable so tests drive ensure/sign without a real custody provider.
    readonly custody?: CustodyGateway;
    readonly now?: () => Date;
}

export const walletHttpRoutes = ({ config, prisma, custody, now = () => new Date() }: WalletDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const ingress = ingressServer(app, `/wallet`);
    const gateway = (): CustodyGateway => custody ?? custodyGateway(config);

    // 404, not 401, for an unknown token: neither a probe nor a disabled feature should learn which part was wrong.
    const ownerOf = async (token: string | undefined): Promise<string | undefined> => {
        if (token === undefined) {
            return undefined;
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { ownerId: true } });
        return sandbox?.ownerId;
    };

    /* The ensure route returns an address and does not set spending caps. */
    ingress(`walletEnsure`, async (c, kit) => {
        if (!walletEnabled(config)) {
            return kit.refuse(404, `wallet signing is not enabled on this platform`);
        }
        const ownerId = await ownerOf(kit.connectToken);
        if (ownerId === undefined) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const parsed = await kit.body();
        if (parsed === undefined) {
            return kit.refuse(400, `the ensure body must be {"network":"eip155:…"}`);
        }
        const { network } = parsed;
        if (usdcNetworkOf(network) === undefined) {
            return kit.refuse(400, `this platform signs USDC on ${SIGNED_NETWORKS} only`);
        }
        try {
            const wallet = await ensureWallet(prisma, gateway(), ownerId, network);
            return kit.answer({ address: wallet.address });
        } catch (error) {
            c.get(`logger`).warn({ err: error }, `wallet ensure failed`);
            return kit.refuse(502, error instanceof Error ? error.message : `the wallet could not be created`);
        }
    });

    // One signature over one fully-specified transfer; everything is checked against this database, never against what
    // the caller asserted. The caller's numbers are only ever used to refuse.
    ingress(`walletSign`, async (c, kit) => {
        if (!walletEnabled(config)) {
            return kit.refuse(404, `wallet signing is not enabled on this platform`);
        }
        const ownerId = await ownerOf(kit.connectToken);
        if (ownerId === undefined) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const parsed = await kit.body();
        if (parsed === undefined) {
            return kit.refuse(400, `the sign body must carry a network, asset, EIP-712 domain, amount, host and authorization`);
        }
        const { network, asset, domainName, domainVersion, amountUsd, host, authorization } = parsed;
        const known = usdcNetworkOf(network);
        if (known === undefined) {
            return kit.refuse(400, `this platform signs USDC on ${SIGNED_NETWORKS} only`);
        }
        // Checked against this table, not the caller's claim; another contract is what a compromised sandbox wants.
        if (asset.toLowerCase() !== known.asset.toLowerCase()) {
            return kit.refuse(400, `this platform signs USDC transfers only (${known.asset} on ${network})`);
        }
        const wallet = await prisma.wallet.findUnique({ where: { userId_network: { userId: ownerId, network } } });
        if (wallet === null) {
            return kit.refuse(404, `no wallet exists for this account on ${network}`);
        }
        // `from` is the only field deciding whose money moves; a mismatch means signing for somebody else.
        if (authorization.from.toLowerCase() !== wallet.address.toLowerCase()) {
            return kit.refuse(403, `the authorization does not spend this account's wallet`);
        }
        // Stated amount and the authorization's actual value must agree: caps check the former, money follows the
        // latter.
        const value = BigInt(authorization.value);
        if (value !== usdToAtomic(amountUsd)) {
            return kit.refuse(400, `the stated amount and the authorization's value disagree`);
        }
        if (value <= 0n) {
            return kit.refuse(400, `nothing to sign: the authorization moves no value`);
        }
        const validity = Number(authorization.validBefore) - Number(authorization.validAfter);
        if (validity <= 0 || validity > MAX_VALIDITY_S) {
            return kit.refuse(400, `the authorization's validity window must be positive and at most ${MAX_VALIDITY_S}s`);
        }
        if (Number(authorization.validBefore) * 1000 <= now().getTime()) {
            return kit.refuse(400, `the authorization has already expired`);
        }
        if (value > usdToAtomic(wallet.perPaymentMaxUsd)) {
            return kit.refuse(403, `$${amountUsd} is over this wallet's per-payment ceiling of $${wallet.perPaymentMaxUsd}`);
        }

        // Day's total is read and the new row written in one transaction, so two racing requests can't both be told
        // yes; serializable isolation is right since the read decides the write.
        const day = utcDay(now());
        const cap = usdToAtomic(wallet.dailyCapUsd);
        let payment: { id: string };
        try {
            payment = await prisma.$transaction(
                async (tx) => {
                    const today = await tx.walletPayment.findMany({ where: { walletId: wallet.id, day }, select: { amountUsd: true } });
                    const spent = today.reduce((total, row) => total + usdToAtomic(row.amountUsd), 0n);
                    if (spent + value > cap) {
                        throw new DailyCapExceeded(`$${amountUsd} would pass this wallet's $${wallet.dailyCapUsd} daily cap: $${atomicToUsd(spent)} is already spent today`);
                    }
                    return tx.walletPayment.create({
                        data: { walletId: wallet.id, userId: ownerId, day, amountUsd, host, payTo: authorization.to },
                        select: { id: true },
                    });
                },
                { isolationLevel: `Serializable` },
            );
        } catch (error) {
            if (error instanceof DailyCapExceeded) {
                return kit.refuse(403, error.message);
            }
            c.get(`logger`).error({ err: error, walletId: wallet.id }, `wallet sign: the daily cap could not be checked`);
            return kit.refuse(503, `the daily cap could not be checked; nothing was signed, try again`);
        }

        // EIP-3009 TransferWithAuthorization in the token's own domain. name/version come from the relayed challenge
        // (the price-setter knows its token); chainId/verifyingContract come from this table, so a challenge can't
        // redirect the signature.
        const typedData: TypedData = {
            domain: { name: domainName, version: domainVersion, chainId: known.chainId, verifyingContract: known.asset },
            primaryType: `TransferWithAuthorization`,
            types: {
                TransferWithAuthorization: [
                    { name: `from`, type: `address` },
                    { name: `to`, type: `address` },
                    { name: `value`, type: `uint256` },
                    { name: `validAfter`, type: `uint256` },
                    { name: `validBefore`, type: `uint256` },
                    { name: `nonce`, type: `bytes32` },
                ],
            },
            message: { ...authorization },
        };
        try {
            const signature = await gateway().signTypedData(wallet.providerWalletId, typedData);
            return kit.answer({ signature });
        } catch (error) {
            // Row is deleted, not left as a phantom spend: no authorization exists to ever settle it, and leaving it
            // would eat the daily cap for a payment that never happened.
            await prisma.walletPayment
                .delete({ where: { id: payment.id } })
                .catch((deleteError: unknown) =>
                    c.get(`logger`).error({ err: deleteError, paymentId: payment.id }, `wallet sign: an unsigned payment row could not be dropped; it counts against today's cap`),
                );
            c.get(`logger`).warn({ err: error }, `wallet sign failed`);
            return kit.refuse(502, error instanceof Error ? error.message : `the signature could not be produced`);
        }
    });

    return app;
};
