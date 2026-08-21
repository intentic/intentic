import type { PrismaClient } from "@intentic-app/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { type CustodyGateway, custodyGateway, type TypedData, walletEnabled } from "./wallet-custody.js";

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
 * The row is written BEFORE the signature is returned, inside the same transaction that reads the day's
 * total, so two concurrent requests cannot both fit under one remaining cap. An authorization that is never
 * settled therefore counts against the day, the conservative direction, and it self-corrects tomorrow.
 *
 * Everything 404s when no custody provider is configured, the pool's pattern verbatim. */

// USDC's six decimals, as bigint atomic units. Money arithmetic never touches a float here, the sandbox's
// x402 module makes the same promise on its side, and the two agree because both go through these.
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

// The chains this signer will mint for, and the token it will mint for on each, the compliance surface as
// a lookup: USDC only, `exact` scheme only, so every signature is a fixed-amount transfer of a
// dollar-pegged token the owner's caps are honestly written in.
const NETWORKS: Record<string, { readonly chainId: number; readonly asset: string }> = {
    "eip155:8453": { chainId: 8453, asset: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` },
    "eip155:84532": { chainId: 84532, asset: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` },
};

const usd = z.string().regex(USD_RE);

const EnsureSchema = z.object({
    network: z.string(),
    policy: z.object({ perPaymentMaxUsd: usd, dailyCapUsd: usd }),
});

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

// The authorization's own validity window, bounded here as well as at the daemon: a signature is a bearer
// instrument until it expires, and one good for an hour is a different object from one good for five
// minutes. Anything longer is refused rather than trimmed, silently signing something other than what was
// asked for is worse than saying no.
const MAX_VALIDITY_S = 600;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

export interface WalletDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    // Injectable so tests drive ensure/sign without a custody provider, the pool's gateway pattern.
    readonly custody?: CustodyGateway;
    readonly now?: () => Date;
}

export const walletHttpRoutes = ({ config, prisma, custody, now = () => new Date() }: WalletDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const gateway = (): CustodyGateway => custody ?? custodyGateway(config);

    // 404-not-401 for an unknown token, the pool's reasoning verbatim: neither a probe nor a disabled
    // feature should teach a caller which part was wrong.
    const ownerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<string | undefined> => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return undefined;
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { ownerId: true } });
        return sandbox?.ownerId;
    };

    /* Create-or-return this member's wallet, and mirror the capability card's caps onto it. Called by the
     * wallet capability's apply, so editing the card is what re-states the numbers this signer enforces,
     * and the two can never drift into disagreeing about what the owner set. */
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
            return c.json({ error: `the ensure body must be {"network":"eip155:…","policy":{"perPaymentMaxUsd":"1.00","dailyCapUsd":"5.00"}}` }, 400);
        }
        const { network, policy } = parsed.data;
        if (NETWORKS[network] === undefined) {
            return c.json({ error: `this platform signs USDC on ${Object.keys(NETWORKS).join(`, `)} only` }, 400);
        }
        const existing = await prisma.wallet.findUnique({ where: { userId_network: { userId: ownerId, network } } });
        if (existing !== null) {
            await prisma.wallet.update({
                where: { id: existing.id },
                data: { perPaymentMaxUsd: policy.perPaymentMaxUsd, dailyCapUsd: policy.dailyCapUsd },
            });
            return c.json({ address: existing.address });
        }
        try {
            // `reference` is the platform's own stable id for this member+network, which is what makes the
            // provider's create idempotent: a retried ensure returns the same wallet rather than minting a
            // second one the owner would then have to fund twice.
            const created = await gateway().wallet(`${ownerId}:${network}`, network);
            const wallet = await prisma.wallet.create({
                data: {
                    userId: ownerId,
                    network,
                    address: created.address,
                    providerWalletId: created.id,
                    perPaymentMaxUsd: policy.perPaymentMaxUsd,
                    dailyCapUsd: policy.dailyCapUsd,
                },
            });
            return c.json({ address: wallet.address });
        } catch (error) {
            c.get(`logger`)?.warn({ err: error }, `wallet ensure failed`);
            return c.json({ error: error instanceof Error ? error.message : `the wallet could not be created` }, 502);
        }
    });

    /* ONE SIGNATURE, over one fully-specified transfer. Everything checked here is checked against this
     * database rather than against anything the caller asserted: which wallet is the member's, what its
     * caps are, what today already spent. The caller's own numbers are only ever used to REFUSE. */
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
        // USDC-only, enforced against this table rather than against the token the caller named, a
        // signature over some other contract's typed data is exactly what a compromised sandbox would ask
        // for, and it is the one thing no cap would catch.
        if (asset.toLowerCase() !== known.asset.toLowerCase()) {
            return c.json({ error: `this platform signs USDC transfers only (${known.asset} on ${network})` }, 400);
        }
        const wallet = await prisma.wallet.findUnique({ where: { userId_network: { userId: ownerId, network } } });
        if (wallet === null) {
            return c.json({ error: `no wallet exists for this account on ${network}` }, 404);
        }
        // The authorization must spend THIS wallet: `from` is the only field that decides whose money moves,
        // and a mismatch is a caller asking us to sign for somebody else.
        if (authorization.from.toLowerCase() !== wallet.address.toLowerCase()) {
            return c.json({ error: `the authorization does not spend this account's wallet` }, 403);
        }
        // The amount the caller states and the amount the authorization actually moves must agree, because
        // the caps are checked against the former and the money follows the latter.
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

        /* THE CAP, AND THE ROW, IN ONE TRANSACTION. The day's total is read and the new row written
         * together, so two sandboxes (or two turns) racing the same remaining cap cannot both be told yes.
         * Serializable is the right isolation precisely because the read decides the write. */
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

        /* The typed data itself. EIP-3009's TransferWithAuthorization, in the token's own EIP-712 domain.
         * `name`/`version` ride from the endpoint's challenge (relayed by the sandbox) because the domain
         * must match what the token contract hashes, and the server publishing the price knows its token;
         * `chainId`/`verifyingContract` come from THIS table, so a challenge cannot redirect the signature
         * onto another chain or another contract. */
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
            /* The custody provider refused after the row was written. The row is DELETED rather than left
             * as a phantom spend: no authorization exists, so nothing can ever settle against it, and
             * leaving it would quietly eat the owner's daily cap for a payment that never happened. */
            await prisma.walletPayment.delete({ where: { id: payment.id } }).catch(() => undefined);
            c.get(`logger`)?.warn({ err: error }, `wallet sign failed`);
            return c.json({ error: error instanceof Error ? error.message : `the signature could not be produced` }, 502);
        }
    });

    return app;
};
