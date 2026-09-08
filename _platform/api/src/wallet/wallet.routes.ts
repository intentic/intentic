import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { type CustodyGateway, custodyGateway, type TypedData, walletEnabled } from "./wallet-custody.js";
import { ensureWallet, NETWORKS } from "./wallet-store.js";

/* THE WALLET SIGNER, the platform's two sandbox-facing routes, and the place where "the agent cannot spend
 * what its owner didn't release" stops being a policy and becomes arithmetic somebody else's process does.
 *
 * A sandbox reaches these with its connect token (the pool routes' ownerOf pattern), which names WHOSE
 * wallet signs. It sends a fully-specified transfer authorization, recipient, exact amount, validity
 * window, nonce, and gets back one EIP-712 signature or a refusal. It never sends "please pay this URL"
 * and it never receives key material: the key is held by a custody provider (wallet-custody.ts), and the
 * platform's own credential for it never leaves this process.
 *
 * THE CAPS ARE RE-CHECKED HERE, and that is the whole point of the route existing rather than the daemon
 * signing for itself. The sandbox checks policy too, that check is the UX, so a refusal reads well and
 * costs no round trip, but the container is not a trust boundary (its agent and its daemon are one root
 * process tree), so the number that actually binds is this one, computed from THIS database's own payment
 * rows. A compromised sandbox can at worst spend what its owner already delegated on the capability card.
 *
 * AND THE CAPS ARE NOT WRITTEN HERE, for the same reason. Nothing a connect token can reach may set the
 * number a connect token is then held to: the caps arrive over the owner's SESSION (wallet.orpc.ts, from the
 * editor as the card is saved), and a sandbox's ensure gets exactly the one thing it needs, an address.
 *
 * The row is written BEFORE the signature is returned, inside the same transaction that reads the day's
 * total, so two concurrent requests cannot both fit under one remaining cap. An authorization that is never
 * settled therefore counts against the day, the conservative direction, and it self-corrects tomorrow.
 *
 * Everything 404s when no custody provider is configured, the pool's pattern verbatim. */

// USDC's six decimals as bigint units; arithmetic never touches a float, matching the sandbox's x402 module.
const ATOMIC_PER_USD = 1_000_000n;
const USD_RE = /^\d+(\.\d{1,6})?$/;

const usdToAtomic = (usd: string): bigint => {
    const [whole, fraction = ``] = usd.split(`.`);
    return BigInt(whole || `0`) * ATOMIC_PER_USD + BigInt(fraction.padEnd(6, `0`).slice(0, 6) || `0`);
};

const atomicToUsd = (atomic: bigint): string => {
    const whole = atomic / ATOMIC_PER_USD;
    const fraction = (atomic % ATOMIC_PER_USD).toString().padStart(6, `0`).replace(/0+$/, ``);
    return fraction === `` ? `${whole}.00` : `${whole}.${fraction.padEnd(2, `0`)}`;
};

const usd = z.string().regex(USD_RE);

const EnsureSchema = z.object({ network: z.string() });

const SignSchema = z.object({
    network: z.string(),
    asset: z.string(),
    domainName: z.string().min(1),
    domainVersion: z.string().min(1),
    amountUsd: usd,
    host: z.string().min(1),
    authorization: z.object({
        from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        value: z.string().regex(/^\d+$/),
        validAfter: z.string().regex(/^\d+$/),
        validBefore: z.string().regex(/^\d+$/),
        nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }),
});

// Validity ceiling: a signature is a bearer instrument until it expires; too long is refused, never trimmed.
const MAX_VALIDITY_S = 600;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export interface WalletDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injectable so tests drive ensure/sign without a real custody provider.
    readonly custody?: CustodyGateway;
    readonly now?: () => Date;
}

export const walletHttpRoutes = ({ config, prisma, custody, now = () => new Date() }: WalletDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const gateway = (): CustodyGateway => custody ?? custodyGateway(config);

    // 404, not 401, for an unknown token: neither a probe nor a disabled feature should learn which part was wrong.
    const ownerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<string | undefined> => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return undefined;
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { ownerId: true } });
        return sandbox?.ownerId;
    };

    /* Create-or-return this member's wallet: the ADDRESS, and nothing about the caps. Called by the wallet
     * capability's apply so the card can show where to send funds. The caps this signer enforces are the
     * owner's to state, over a session (wallet.orpc.ts); a wallet the sandbox brings into being here carries
     * the schema's defaults until the owner does. */
    app.post(`/ensure`, async (c) => {
        if (!walletEnabled(config)) {
            return c.json({ error: `wallet signing is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const parsed = EnsureSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: `the ensure body must be {"network":"eip155:…"}` }, 400);
        }
        const { network } = parsed.data;
        if (NETWORKS[network] === undefined) {
            return c.json({ error: `this platform signs USDC on ${Object.keys(NETWORKS).join(`, `)} only` }, 400);
        }
        try {
            const wallet = await ensureWallet(prisma, gateway(), ownerId, network);
            return c.json({ address: wallet.address });
        } catch (error) {
            c.get(`logger`)?.warn({ err: error }, `wallet ensure failed`);
            return c.json({ error: error instanceof Error ? error.message : `the wallet could not be created` }, 502);
        }
    });

    // One signature over one fully-specified transfer; everything is checked against this database, never against what
    // the caller asserted. The caller's numbers are only ever used to refuse.
    app.post(`/sign`, async (c) => {
        if (!walletEnabled(config)) {
            return c.json({ error: `wallet signing is not enabled on this platform` }, 404);
        }
        const ownerId = await ownerOf(c);
        if (ownerId === undefined) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        const parsed = SignSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: `the sign body must carry a network, asset, EIP-712 domain, amount, host and authorization` }, 400);
        }
        const { network, asset, domainName, domainVersion, amountUsd, host, authorization } = parsed.data;
        const known = NETWORKS[network];
        if (known === undefined) {
            return c.json({ error: `this platform signs USDC on ${Object.keys(NETWORKS).join(`, `)} only` }, 400);
        }
        // Checked against this table, not the caller's claim; another contract is what a compromised sandbox wants.
        if (asset.toLowerCase() !== known.asset.toLowerCase()) {
            return c.json({ error: `this platform signs USDC transfers only (${known.asset} on ${network})` }, 400);
        }
        const wallet = await prisma.wallet.findUnique({ where: { userId_network: { userId: ownerId, network } } });
        if (wallet === null) {
            return c.json({ error: `no wallet exists for this account on ${network}` }, 404);
        }
        // `from` is the only field deciding whose money moves; a mismatch means signing for somebody else.
        if (authorization.from.toLowerCase() !== wallet.address.toLowerCase()) {
            return c.json({ error: `the authorization does not spend this account's wallet` }, 403);
        }
        // Stated amount and the authorization's actual value must agree: caps check the former, money follows the
        // latter.
        const value = BigInt(authorization.value);
        if (value !== usdToAtomic(amountUsd)) {
            return c.json({ error: `the stated amount and the authorization's value disagree` }, 400);
        }
        if (value <= 0n) {
            return c.json({ error: `nothing to sign: the authorization moves no value` }, 400);
        }
        const validity = Number(authorization.validBefore) - Number(authorization.validAfter);
        if (validity <= 0 || validity > MAX_VALIDITY_S) {
            return c.json({ error: `the authorization's validity window must be positive and at most ${MAX_VALIDITY_S}s` }, 400);
        }
        if (Number(authorization.validBefore) * 1000 <= now().getTime()) {
            return c.json({ error: `the authorization has already expired` }, 400);
        }
        if (value > usdToAtomic(wallet.perPaymentMaxUsd)) {
            return c.json({ error: `$${amountUsd} is over this wallet's per-payment ceiling of $${wallet.perPaymentMaxUsd}` }, 403);
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
                        throw new Error(`$${amountUsd} would pass this wallet's $${wallet.dailyCapUsd} daily cap: $${atomicToUsd(spent)} is already spent today`);
                    }
                    return tx.walletPayment.create({
                        data: { walletId: wallet.id, userId: ownerId, day, amountUsd, host, payTo: authorization.to },
                        select: { id: true },
                    });
                },
                { isolationLevel: `Serializable` },
            );
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : `the daily cap check failed` }, 403);
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
            return c.json({ signature });
        } catch (error) {
            // Row is deleted, not left as a phantom spend: no authorization exists to ever settle it, and leaving it
            // would eat the daily cap for a payment that never happened.
            await prisma.walletPayment.delete({ where: { id: payment.id } }).catch(() => undefined);
            c.get(`logger`)?.warn({ err: error }, `wallet sign failed`);
            return c.json({ error: error instanceof Error ? error.message : `the signature could not be produced` }, 502);
        }
    });

    return app;
};
