import type { PrismaClient } from "@intentic-app/prisma";

/* THE SPEND GATE, OFF-SANDBOX — the same wall as the daemon's approval card (sandbox
 * platform/service-offer.ts), rebuilt for a caller that has no daemon, no conversation and no held connection.
 *
 * In a sandbox the gate is a live object: the agent's CLI call parks inside the daemon, a card goes up in the
 * owner's turn, and the held socket IS the waiter. None of that survives the trip to a stranger's laptop. An
 * MCP client asks, gets told to open a URL, and comes back LATER — after a browser round trip, possibly in a
 * different process, certainly across a stateless HTTP boundary. So the offer has to be written down, and once
 * it is written down the row is the grant.
 *
 * THE ONE RULE THAT MAKES THIS A GATE AND NOT A PROMPT: `pending` → `approved` happens only in `settle`, which
 * is reachable only from the approval page under the owner's own browser session (pool.orpc.ts). The MCP
 * client's elicitation answer is never read as consent and never touches this table — the run calls `consume`,
 * which re-reads the row. That is deliberate and load-bearing: Claude Code ships an `Elicitation` hook that can
 * auto-answer elicitation dialogs without showing them, and a user who configures one must not thereby be
 * spending. A hook that auto-confirms buys a `consume` that finds nothing approved.
 *
 * ONE APPROVAL RELEASES EXACTLY ONE RUN, the sandbox's property preserved by a conditional update rather than
 * by a socket closing: `approved` → `spent` is an updateMany filtered on the current status, so a tool call
 * retried twice (a flaky network, an impatient model) charges once and the second attempt reads as
 * `already_spent`. */

// How long an unanswered offer stands. The sandbox's card holds a live connection for ten minutes; this holds
// a row for the same span, for the same reason — long enough for someone who stepped away, short enough that
// an abandoned ask cannot be approved into a charge tomorrow.
export const OFFER_TTL_MS = 10 * 60_000;

/* How long a YES stays spendable after it is given. In a sandbox this question cannot arise: the daemon is
 * holding the socket, so the click and the run are the same instant, and a click nobody is waiting behind
 * settles a card that already died. Here they are separated by a browser round trip and a client's retry —
 * which is usually seconds, but nothing in the protocol says it has to be.
 *
 * So an approval gets a clock of its own. Generous next to the retry it exists for, and short next to
 * "somebody approved this before lunch and the agent got round to it after": consent to spend is consent to
 * spend NOW, and a grant that outlived the conversation it belonged to is not one anybody would recognise. */
export const GRANT_TTL_MS = 15 * 60_000;

// The agent's why, capped — one line of rationale is the card's design, not a second request body. Same number
// as the sandbox CLI's, so the two surfaces show the same amount of it.
export const WHY_MAX = 280;

export type OfferStatus = `pending` | `approved` | `declined` | `spent` | `expired`;

// What the approval page renders. Every number here was written at offer time and is read back rather than
// recomputed, so the page, the receipt and the charge cannot disagree about the price even if the listing is
// repriced while the owner is deciding.
export interface OfferCard {
    readonly id: string;
    readonly status: OfferStatus;
    readonly slug: string;
    readonly name: string;
    readonly publisher: string;
    readonly description: string;
    readonly credits: number;
    readonly probation: boolean;
    readonly request: string;
    readonly why: string | undefined;
    readonly expiresAt: string;
}

export const createOffer = async (
    prisma: PrismaClient,
    input: {
        readonly userId: string;
        readonly serviceId: string;
        readonly credits: number;
        readonly request: string;
        readonly why?: string | undefined;
    },
    now: Date,
): Promise<string> => {
    const why = input.why === undefined || input.why.trim() === `` ? undefined : input.why.trim().slice(0, WHY_MAX);
    const offer = await prisma.serviceOffer.create({
        data: {
            userId: input.userId,
            serviceId: input.serviceId,
            credits: input.credits,
            request: input.request,
            ...(why !== undefined ? { why } : {}),
            expiresAt: new Date(now.getTime() + OFFER_TTL_MS),
        },
        select: { id: true },
    });
    return offer.id;
};

/* How long a SETTLED offer keeps answering for an identical request. Only the protocol's own retry needs to
 * land on it: "you declined this" has to be said once rather than becoming a fresh card the instant the client
 * asks again. Short on purpose — an owner who says "go on then" two minutes later is asking a new question and
 * deserves a new card, which is exactly what a sandbox gives them. */
const SETTLED_GRACE_MS = 2 * 60_000;

/* HOW A RETRY FINDS ITS OWN OFFER, without the server remembering anything.
 *
 * The elicitation dance is: tool call → "open this URL" → the user does something in a browser → the CLIENT
 * RETRIES THE SAME TOOL CALL. The retry carries the same arguments and nothing else useful; there is no
 * continuation to thread, and pinning one to a connection would break the moment the api restarts or a second
 * replica answers. So the offer is found the way it was made — by (owner, service, exact request body) — and
 * the newest row wins.
 *
 * That gives the right behaviour in all four cases that matter, with no state anywhere:
 *   - the card is still up          → the retry re-opens the SAME card instead of stacking a second one;
 *   - the owner approved            → the retry consumes that grant and runs;
 *   - the owner declined or ignored → the retry is told so, once, inside the grace window above;
 *   - a genuine repeat later        → nothing recent is found, and a fresh card goes up. One click, one run.
 *
 * `spent` is excluded outright rather than graced: a run that already happened must never make the next
 * identical ask look answered. */
export const findRecentOffer = async (
    prisma: PrismaClient,
    input: { readonly userId: string; readonly serviceId: string; readonly request: string },
    now: Date,
): Promise<{ readonly id: string; readonly status: OfferStatus; readonly expiresAt: Date } | undefined> => {
    const offer = await prisma.serviceOffer.findFirst({
        where: {
            userId: input.userId,
            serviceId: input.serviceId,
            request: input.request,
            OR: [
                { status: `pending` },
                // An approval only counts while it is still spendable — past its grant window it is not a
                // licence the retry may quietly use, and consumeGrant would refuse it anyway.
                { status: `approved`, decidedAt: { gt: new Date(now.getTime() - GRANT_TTL_MS) } },
                { status: { in: [`declined`, `expired`] }, decidedAt: { gt: new Date(now.getTime() - SETTLED_GRACE_MS) } },
            ],
        },
        orderBy: { createdAt: `desc` },
        select: { id: true, status: true, expiresAt: true },
    });
    return offer === null ? undefined : { id: offer.id, status: offer.status as OfferStatus, expiresAt: offer.expiresAt };
};

/* An offer as its owner may read it. Scoped to `userId` on purpose: an offer id is a cuid in a URL, and the
 * page it opens shows a request body the agent composed — which can carry anything the task was about. Only
 * the account that asked may see it.
 *
 * An expired row reads as `expired` rather than `pending` without being written, so a page opened late says
 * the true thing even before the sweep runs. */
export const readOffer = async (prisma: PrismaClient, id: string, userId: string, now: Date): Promise<OfferCard | undefined> => {
    const offer = await prisma.serviceOffer.findFirst({
        where: { id, userId },
        include: { service: { select: { slug: true, name: true, publisher: true, description: true, status: true } } },
    });
    if (offer === null) {
        return undefined;
    }
    const status = (offer.status === `pending` && offer.expiresAt <= now ? `expired` : offer.status) as OfferStatus;
    return {
        id: offer.id,
        status,
        slug: offer.service.slug,
        name: offer.service.name,
        publisher: offer.service.publisher,
        description: offer.service.description,
        credits: offer.credits,
        probation: offer.service.status === `probation`,
        request: offer.request,
        why: offer.why ?? undefined,
        expiresAt: offer.expiresAt.toISOString(),
    };
};

export type SettleOutcome = `approved` | `declined` | `already_settled` | `expired` | `unknown`;

/* THE CLICK. The only door from `pending` to `approved`, and the reason it takes a `userId` and a live clock:
 * the caller is the approval page, authenticated by the owner's browser session, and an offer that ran out
 * while the page was open must not settle as a yes.
 *
 * `updateMany` filtered on `pending` rather than a read-then-write, so two tabs racing the same card produce
 * one decision and one `already_settled`. */
export const settleOffer = async (prisma: PrismaClient, id: string, userId: string, approve: boolean, now: Date): Promise<SettleOutcome> => {
    const offer = await prisma.serviceOffer.findFirst({ where: { id, userId }, select: { status: true, expiresAt: true } });
    if (offer === null) {
        return `unknown`;
    }
    if (offer.status !== `pending`) {
        return `already_settled`;
    }
    if (offer.expiresAt <= now) {
        await prisma.serviceOffer.updateMany({ where: { id, status: `pending` }, data: { status: `expired`, decidedAt: now } });
        return `expired`;
    }
    const settled = await prisma.serviceOffer.updateMany({
        where: { id, status: `pending`, expiresAt: { gt: now } },
        data: { status: approve ? `approved` : `declined`, decidedAt: now },
    });
    if (settled.count === 0) {
        return `already_settled`;
    }
    return approve ? `approved` : `declined`;
};

export type GrantOutcome =
    // The grant was live and is now spent. `request` and `credits` are the offer's own, not the caller's.
    | { readonly kind: `granted`; readonly serviceId: string; readonly slug: string; readonly request: string; readonly credits: number }
    // Every way an offer is not a licence to spend, each with its own sentence at the call site.
    | { readonly kind: `pending` }
    | { readonly kind: `declined` }
    | { readonly kind: `expired` }
    | { readonly kind: `already_spent` }
    | { readonly kind: `unknown` };

/* SPEND THE GRANT — called by the run, once, immediately before the money moves.
 *
 * This is where the port's honesty lives. The MCP client told us the user consented; that claim is not read
 * here and is not read anywhere. What is read is the row the OWNER's browser wrote. A client that lies, a hook
 * that auto-answers, a model that retries hopefully — all of them land on `pending` and get a sentence back. */
export const consumeGrant = async (prisma: PrismaClient, id: string, userId: string, now: Date): Promise<GrantOutcome> => {
    const offer = await prisma.serviceOffer.findFirst({
        where: { id, userId },
        include: { service: { select: { id: true, slug: true } } },
    });
    if (offer === null) {
        return { kind: `unknown` };
    }
    if (offer.status === `declined`) {
        return { kind: `declined` };
    }
    if (offer.status === `spent`) {
        return { kind: `already_spent` };
    }
    if (offer.status === `expired` || (offer.status === `pending` && offer.expiresAt <= now)) {
        return { kind: `expired` };
    }
    if (offer.status === `pending`) {
        return { kind: `pending` };
    }
    // A yes that has gone cold. Marked rather than merely refused, so the row stops reading as a live grant.
    if (offer.decidedAt !== null && offer.decidedAt.getTime() + GRANT_TTL_MS <= now.getTime()) {
        await prisma.serviceOffer.updateMany({ where: { id, status: `approved` }, data: { status: `expired` } });
        return { kind: `expired` };
    }
    // approved → spent, conditionally: the loser of a race reads as already spent and charges nothing.
    const claimed = await prisma.serviceOffer.updateMany({ where: { id, status: `approved` }, data: { status: `spent` } });
    if (claimed.count === 0) {
        return { kind: `already_spent` };
    }
    return { kind: `granted`, serviceId: offer.service.id, slug: offer.service.slug, request: offer.request, credits: offer.credits };
};

// Sweep: mark the abandoned ones so the table's `pending` rows always mean "somebody might still click". Not a
// correctness requirement — every reader above already treats a lapsed row as expired — but a table that tells
// the truth at rest is worth the one statement.
export const expireOffers = async (prisma: PrismaClient, now: Date): Promise<number> => {
    const swept = await prisma.serviceOffer.updateMany({ where: { status: `pending`, expiresAt: { lte: now } }, data: { status: `expired` } });
    return swept.count;
};
