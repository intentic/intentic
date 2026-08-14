import { apiContract, type ClaimChallenge, type CreatorState, type PublisherClaim } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { poolEnabled } from "../pool/pool-membership.js";
import { type StripeGateway, stripeGateway } from "../pool/pool-stripe.js";
import { CLAIM_PATH, checkClaim, claimToken, type RegistryReader, registryReader } from "./creator-claim.js";
import { payoutState, startPayoutSetup } from "./creator-payouts.js";

const os = implement(apiContract).$context<OrpcContext>();

/* THE CREATOR SURFACE — the browser half of getting paid, and the first place the pool has ever been able to
 * answer "who is this money for". Everything here is one of two questions: is this publisher name mine, and
 * can money reach me.
 *
 * The whole family refuses on a platform whose pool is off, matching the membership routes beside it: a
 * platform that sells nothing owes nobody, and saying so tersely beats explaining. Both dependencies are
 * injectable the way the pool's gateway is, so the tests drive a claim end to end without GitHub or Stripe. */

const requirePool = (context: OrpcContext): void => {
    if (!poolEnabled(context.config)) {
        throw new ORPCError(`NOT_FOUND`, { message: `the creator pool is not enabled on this platform` });
    }
};

const claimsOf = async (context: OrpcContext, userId: string): Promise<PublisherClaim[]> => {
    const claims = await context.prisma.publisherClaim.findMany({
        where: { userId },
        select: { publisher: true, repo: true, createdAt: true },
        orderBy: { publisher: `asc` },
    });
    return claims.map((claim) => ({ publisher: claim.publisher, repo: claim.repo, claimedAt: claim.createdAt.toISOString() }));
};

export interface CreatorDeps {
    // Injectable so tests drive checkout-less payout flows, exactly as the pool's routes take a gateway.
    readonly gateway?: StripeGateway;
    // Injectable so tests answer registry reads without the network.
    readonly reader?: RegistryReader;
    readonly fetchFn?: typeof fetch;
}

export const creatorRoutes = ({ gateway, reader, fetchFn = fetch }: CreatorDeps = {}) => {
    const stripeOf = (context: OrpcContext): StripeGateway => gateway ?? stripeGateway(context.config.pool.stripeSecretKey);
    const readerOf = (context: OrpcContext): RegistryReader => reader ?? registryReader(context.config, fetchFn);
    return {
        /* What this account holds today. Signed in but holding nothing is the ordinary first visit, and it
         * answers with empty claims and an unconnected payout state rather than an error — the screen needs
         * something to render the offer against. */
        status: os.creator.status.handler(async ({ context }): Promise<CreatorState> => {
            if (!poolEnabled(context.config)) {
                return { enabled: false, claims: [], statements: [], payments: [] };
            }
            const user = requireUser(context);
            const [claims, payouts] = await Promise.all([claimsOf(context, user.id), payoutState(context.prisma, stripeOf(context), user.id)]);
            /* Statements are looked up by the names the caller holds, not by a stored user id: a creator who
             * claims in October is owed for July, and the frozen rows are never rewritten to say so. Money
             * already swept back into the pool is excluded — it is no longer theirs, and listing it as an
             * earning with no payment behind it would be the most misleading row on the screen. */
            const [statements, payments] = await Promise.all([
                claims.length === 0
                    ? []
                    : context.prisma.creatorStatement.findMany({
                          // `payoutId: null` is what makes this list "still owed": a settled month leaves it
                          // and appears among the receipts, so the two can never double-count the same money.
                          where: { publisher: { in: claims.map((claim) => claim.publisher) }, expiredAt: null, payoutId: null },
                          select: { month: true, publisher: true, amountCents: true, expiresAt: true, poolMonth: { select: { payableAt: true } } },
                          orderBy: [{ month: `desc` }, { publisher: `asc` }],
                      }),
                context.prisma.creatorPayout.findMany({
                    where: { userId: user.id },
                    select: { amountCents: true, status: true, createdAt: true, paidAt: true, stripeTransferId: true },
                    orderBy: { createdAt: `desc` },
                }),
            ]);
            return {
                enabled: true,
                claims,
                payouts,
                statements: statements.map((statement) => ({
                    month: statement.month,
                    publisher: statement.publisher,
                    amountCents: statement.amountCents,
                    payableAt: statement.poolMonth.payableAt.toISOString(),
                    expiresAt: statement.expiresAt.toISOString(),
                })),
                payments: payments.map((payment) => ({
                    amountCents: payment.amountCents,
                    status: payment.status,
                    createdAt: payment.createdAt.toISOString(),
                    ...(payment.paidAt !== null ? { paidAt: payment.paidAt.toISOString() } : {}),
                    ...(payment.stripeTransferId !== null ? { reference: payment.stripeTransferId } : {}),
                })),
            };
        }),

        /* What proving one name would take. A pure read: it computes the token, names every repository the
         * proof may be published in, and reports whether the name is already spoken for — so the screen can
         * show "already yours" or "held by someone else" instead of walking a creator through an instruction
         * that could never succeed. */
        challenge: os.creator.challenge.handler(async ({ context, input }): Promise<ClaimChallenge> => {
            requirePool(context);
            const user = requireUser(context);
            const [existing, repos] = await Promise.all([
                context.prisma.publisherClaim.findUnique({ where: { publisher: input.publisher }, select: { userId: true } }),
                readerOf(context)
                    .reposOf(input.publisher)
                    // A registry that cannot be read right now must not look like a publisher with no listings:
                    // the screen says "no repositories to prove against" either way, so the failure is logged
                    // and the empty answer stands for one visit rather than breaking the page.
                    .catch((error: unknown) => {
                        context.logger.warn({ err: error, publisher: input.publisher }, `creator: registry read failed`);
                        return [] as readonly string[];
                    }),
            ]);
            return {
                publisher: input.publisher,
                repos: [...repos],
                path: CLAIM_PATH,
                token: claimToken(context.config, user.id, input.publisher),
                claimedByYou: existing?.userId === user.id,
                claimedByOther: existing !== null && existing.userId !== user.id,
            };
        }),

        /* File the claim, but only against a proof that is actually readable right now. Re-claiming a name this
         * account already holds answers with the existing claim rather than an error — a creator clicking twice
         * has done nothing wrong. */
        claim: os.creator.claim.handler(async ({ context, input }): Promise<PublisherClaim> => {
            requirePool(context);
            const user = requireUser(context);
            const existing = await context.prisma.publisherClaim.findUnique({ where: { publisher: input.publisher } });
            if (existing !== null) {
                if (existing.userId !== user.id) {
                    throw new ORPCError(`CONFLICT`, { message: `${input.publisher} is already claimed by another account.` });
                }
                return { publisher: existing.publisher, repo: existing.repo, claimedAt: existing.createdAt.toISOString() };
            }
            const proof = await checkClaim(context.config, readerOf(context), user.id, input.publisher, fetchFn);
            if (proof === undefined) {
                throw new ORPCError(`FORBIDDEN`, {
                    message: `No ${CLAIM_PATH} carrying your claim token was readable in any repository the registry lists under ${input.publisher}.`,
                });
            }
            try {
                const claim = await context.prisma.publisherClaim.create({ data: { publisher: input.publisher, userId: user.id, repo: proof.repo } });
                return { publisher: claim.publisher, repo: claim.repo, claimedAt: claim.createdAt.toISOString() };
            } catch {
                // Two tabs racing the same name: the unique key let exactly one in, and whoever lost is told the
                // same thing a late claimant is told.
                throw new ORPCError(`CONFLICT`, { message: `${input.publisher} is already claimed.` });
            }
        }),

        /* Start or resume payout setup. Answers a Stripe-hosted URL for the browser to navigate to; a creator
         * who abandons it and returns later continues on the same connected account.
         *
         * A Stripe refusal is passed on in Stripe's own words rather than left to become a 500 — the cloud
         * lane's precedent, and it matters more here: the two things that stop this route (Connect not yet
         * enabled on the platform's Stripe account, an account that cannot be onboarded) are both fixed by
         * someone reading the sentence, and "Internal server error" on a card whose whole job is telling a
         * creator what to do next tells them nothing at all. */
        connectPayouts: os.creator.connectPayouts.handler(async ({ context }) => {
            requirePool(context);
            const user = requireUser(context);
            try {
                return await startPayoutSetup(context.prisma, stripeOf(context), context.config, user);
            } catch (error) {
                if (error instanceof Error) {
                    throw new ORPCError(`BAD_GATEWAY`, { message: error.message });
                }
                throw error;
            }
        }),
    };
};
