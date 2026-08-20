import type { PrismaClient, Service } from "@intentic-app/prisma";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { LIVE_STATUSES, type ServiceStatus } from "./pool-admission.js";
import { refundCredits, spendCredits } from "./pool-credits.js";
import { DEMO_SLUG } from "./pool-demo.js";
import { premiumOf } from "./pool-membership.js";
import { type ForwardOutcome, forwardToService } from "./pool-services.js";

/* ONE METERED RUN, WITHOUT A PRESENTATION — the guards, the spend, the signed forward and the refund, lifted
 * out of pool.routes.ts so that two surfaces can drive them and neither can drift from the other.
 *
 * There are two now. The sandbox's daemon POSTs /pool/services/:slug/run and wants an NDJSON stream it can
 * fork (progress to the owner's transcript, the result to the agent). The MCP server (mcp/) wants the same run
 * with the same money rules, but turns progress into protocol notifications and hands back one JSON result.
 * The half that must be identical is everything about the MONEY — spend before the call, a provider's 4xx is
 * a paid answer, no answer is refunded before a receipt exists — so that half lives here and the two callers
 * own only how it looks.
 *
 * WHAT THIS DOES NOT DO IS CONSENT. Neither caller may invoke it on an agent's say-so: the daemon parks on an
 * approval card in the owner's chat, the MCP server parks on an approved ServiceOffer row. This function
 * assumes that already happened and charges accordingly. */

// The refusals that spend nothing, in the platform's own words — every one of them is already written for the
// person who will read it, which is why both callers relay them verbatim rather than rephrasing.
export type MeteredRefusal =
    | { readonly type: `no_such_service` }
    | { readonly type: `membership_required`; readonly serviceName: string }
    | { readonly type: `request_too_large` }
    | {
          readonly type: `insufficient_credits`;
          readonly serviceName: string;
          readonly credits: number;
          readonly allowance: number;
          readonly remaining: number;
          readonly resetsAt: string;
      };

export type MeteredRun =
    // A guard said no. Nothing was spent, and nothing needs settling.
    | { readonly kind: `refused`; readonly refusal: MeteredRefusal }
    // The provider answered with a non-2xx below 500 — a complete answer, CHARGED, relayed verbatim.
    | {
          readonly kind: `answered`;
          readonly service: Service;
          readonly status: number;
          readonly body: string;
          readonly contentType: string;
          readonly remaining: number;
      }
    // Nothing answered. Already refunded and already recorded here — the caller only reports it.
    | { readonly kind: `failed`; readonly service: Service }
    /* The provider is streaming. The caller pulls `events` (each already validated at the trust boundary) and
     * MUST call `settle` with the generator's return value when it is done — that is what writes the run row
     * and refunds a stream that never produced a result. Not settling leaves a charge with no ledger entry,
     * so both callers do it in a finally. */
    | {
          readonly kind: `stream`;
          readonly service: Service;
          readonly events: AsyncGenerator<import("@intentic/sandbox-contract").ServiceStreamEvent, boolean>;
          readonly credits: number;
          readonly remaining: number;
          readonly settle: (served: boolean) => Promise<void>;
      };

export interface MeteredRunDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly fetchFn: typeof fetch;
    readonly now: () => Date;
    /* The demo service's upstream is the platform itself, so its forward dispatches IN-PROCESS rather than
     * over a socket — the platform's own https address is not reliably reachable from the platform (dev's
     * minted certificate fails Bun's TLS stack; prod would loop out through the proxy), and a demo that
     * refunds every run wherever the loopback is awkward demonstrates nothing. The caller supplies it because
     * only the caller holds the Hono app to dispatch into. */
    readonly demoDispatch?: typeof fetch;
    // Warn-level narration for a provider that did not serve; optional so tests stay quiet.
    readonly warn?: ((message: string, service: string) => void) | undefined;
}

// The request cap. A megabyte is far past any real service's body and well short of anything that would make
// the forward a memory event.
const REQUEST_MAX_BYTES = 1_000_000;

export const runMeteredService = async (
    deps: MeteredRunDeps,
    input: { readonly ownerId: string; readonly slug: string; readonly body: string },
): Promise<MeteredRun> => {
    const { config, prisma, fetchFn, now } = deps;
    const service = await prisma.service.findUnique({ where: { slug: input.slug } });
    if (service === null || !LIVE_STATUSES.includes(service.status as ServiceStatus)) {
        return { kind: `refused`, refusal: { type: `no_such_service` } };
    }
    if (!(await premiumOf(prisma, config, input.ownerId))) {
        return { kind: `refused`, refusal: { type: `membership_required`, serviceName: service.name } };
    }
    if (input.body.length > REQUEST_MAX_BYTES) {
        return { kind: `refused`, refusal: { type: `request_too_large` } };
    }
    const at = now();
    /* Spend FIRST, atomically, or two concurrent runs race through the same headroom. A refused spend still
     * landed its increment (the meter is optimistic on purpose — it is the only version that cannot be raced)
     * and is given straight back: unlike a one-message slot, an N-credit bite out of a refused attempt would
     * eat real remaining allowance. */
    const spend = await spendCredits(prisma, config, input.ownerId, service.creditsPerRun, at);
    if (!spend.allowed) {
        await refundCredits(prisma, input.ownerId, service.creditsPerRun, at);
        return {
            kind: `refused`,
            refusal: {
                type: `insufficient_credits`,
                serviceName: service.name,
                credits: service.creditsPerRun,
                allowance: spend.allowance,
                remaining: spend.remaining,
                resetsAt: spend.resetsAt,
            },
        };
    }
    const dispatch = service.slug === DEMO_SLUG && deps.demoDispatch !== undefined ? deps.demoDispatch : fetchFn;
    const forward: ForwardOutcome = await forwardToService(
        service.upstreamUrl,
        decryptSecret(config, service.secret),
        input.body,
        dispatch,
        () => at,
    );
    if (forward.kind === `failed`) {
        await prisma.serviceRun.create({
            data: { userId: input.ownerId, serviceId: service.id, credits: service.creditsPerRun, status: `refunded` },
        });
        await refundCredits(prisma, input.ownerId, service.creditsPerRun, at);
        deps.warn?.(`pool: service did not serve — run refunded`, service.slug);
        return { kind: `failed`, service };
    }
    if (forward.kind === `answered`) {
        await prisma.serviceRun.create({ data: { userId: input.ownerId, serviceId: service.id, credits: service.creditsPerRun, status: `ok` } });
        return {
            kind: `answered`,
            service,
            status: forward.status,
            body: forward.body,
            contentType: forward.contentType,
            remaining: spend.remaining,
        };
    }
    return {
        kind: `stream`,
        service,
        events: forward.events,
        credits: service.creditsPerRun,
        remaining: spend.remaining,
        settle: async (served: boolean) => {
            try {
                await prisma.serviceRun.create({
                    data: { userId: input.ownerId, serviceId: service.id, credits: service.creditsPerRun, status: served ? `ok` : `refunded` },
                });
                if (!served) {
                    await refundCredits(prisma, input.ownerId, service.creditsPerRun, at);
                    deps.warn?.(`pool: service stream ended without a result — run refunded`, service.slug);
                }
            } catch {
                deps.warn?.(`pool: failed to record a streamed run`, service.slug);
            }
        },
    };
};

// The refusal, as JSON and a status code — shared so the HTTP route and the MCP tool say the same sentence.
export const refusalResponse = (refusal: MeteredRefusal): { readonly status: 403 | 404 | 413 | 429; readonly json: Record<string, unknown> } => {
    switch (refusal.type) {
        case `no_such_service`:
            return { status: 404, json: { error: `no such service` } };
        case `membership_required`:
            return {
                status: 403,
                json: { error: { type: `membership_required`, message: `Running ${refusal.serviceName} needs an intentic membership.` } },
            };
        case `request_too_large`:
            return { status: 413, json: { error: `request too large` } };
        case `insufficient_credits`:
            return {
                status: 429,
                json: {
                    error: {
                        type: `insufficient_credits`,
                        message: `This run costs ${refusal.credits} credits and ${refusal.remaining} are left today. The allowance resets at ${refusal.resetsAt}.`,
                    },
                    credits: { allowance: refusal.allowance, remaining: refusal.remaining, resetsAt: refusal.resetsAt },
                },
            };
    }
};
