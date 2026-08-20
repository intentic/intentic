import type { lookup } from "node:dns/promises";
import type { PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { LIVE_STATUSES, probeFailure, probeService, type ServiceStatus } from "./pool-admission.js";

/* THE WATCH, gate 4, and the only one that never finishes.
 *
 * A service has no code to audit, so behaviour is its entire artifact and the whole of its ongoing review.
 * Three mechanisms, every threshold published as config, none of them requiring a person:
 *
 *   GRADUATION  a probation listing that has served enough runs cleanly loses its price ceiling and its badge.
 *   TRIPWIRE    any live listing whose recent refund rate is too high is suspended on the spot. "Refunded"
 *               already means the platform proved it did not answer, so this is not a judgment call, it is
 *               a count of times the provider failed to serve something a member had approved.
 *   CANARY      a re-probe of listings that have gone quiet, so a service that silently died stops being
 *               offered before a member finds out by clicking. Consecutive failures suspend it.
 *
 * OPERATOR ROWS ARE EXEMPT FROM ALL THREE (userId null). They never passed a gate, they answer to no provider,
 * and suspending the platform's own demo because its host was restarting is nobody's idea of a safety
 * mechanism. What governs them is the operator, which is the same thing that created them.
 *
 * A suspension is not a deletion: the row, its runs and its earnings stay, the reason is recorded in the
 * provider's own words-facing sentence, and a fixed endpoint can re-publish into probation. */

// A live service that has actually served recently needs no canary, real traffic is a better liveness proof
// than a synthetic call, and the probe costs the PROVIDER real upstream money every time it runs.
const CANARY_QUIET_MS = 24 * 60 * 60 * 1000;

export type WatchAction = `keep` | `graduate` | `suspend`;

export interface WatchInput {
    readonly status: ServiceStatus;
    // The most recent runs, newest first, as their ledger status, the tripwire's whole evidence.
    readonly recent: readonly string[];
    // Every run this listing has ever served (status `ok`), the graduation counter.
    readonly servedTotal: number;
}

/* The behavioural decision, as a pure function of counted rows, so the thresholds can be tested against
 * every boundary without a database, and so the rule a provider reads on the site is the rule that runs.
 *
 * The tripwire needs a FULL window before it fires. Judging a listing on its first three runs would delist a
 * working service that met one bad afternoon, and the refund already made those three runs free. */
export const watchVerdict = (config: Config, input: WatchInput): WatchAction => {
    if (!LIVE_STATUSES.includes(input.status)) {
        return `keep`;
    }
    const window = input.recent.slice(0, config.pool.watchWindowRuns);
    if (window.length >= config.pool.watchWindowRuns) {
        const refunded = window.filter((status) => status === `refunded`).length;
        if (refunded / window.length > config.pool.maxRefundRate) {
            return `suspend`;
        }
    }
    if (input.status === `probation` && input.servedTotal >= config.pool.graduationRuns) {
        return `graduate`;
    }
    return `keep`;
};

export const suspensionReason = (config: Config): string =>
    `Suspended automatically: more than ${Math.round(config.pool.maxRefundRate * 100)}% of the last ${config.pool.watchWindowRuns} runs failed to answer and were refunded. Fix the endpoint, run the probe, and publish again.`;

interface WatchDeps {
    readonly prisma: PrismaClient;
    readonly config: Config;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => Date;
    // The canary resolves each endpoint before calling it, exactly as the publish probe does; injected for
    // the same reason, so the tests drive a listing whose hostname never existed.
    readonly lookupFn?: typeof lookup;
}

/* One pass over every owned, live listing. Sequential on purpose: this runs daily over a catalog measured in
 * tens, and a canary that fanned out would hammer several providers' upstreams at the same instant for no
 * gain anyone can measure. */
export const runWatch = async ({ prisma, config, fetchFn = fetch, now = () => new Date(), lookupFn }: WatchDeps, logger: Logger): Promise<void> => {
    const at = now();
    const services = await prisma.service.findMany({
        where: { status: { in: [...LIVE_STATUSES] }, userId: { not: null } },
        select: { id: true, slug: true, status: true, upstreamUrl: true, secret: true, sampleRequest: true, canaryFails: true, probedAt: true },
    });
    for (const service of services) {
        const [recent, servedTotal, servedRecently] = await Promise.all([
            prisma.serviceRun.findMany({
                where: { serviceId: service.id },
                select: { status: true },
                orderBy: { createdAt: `desc` },
                take: config.pool.watchWindowRuns,
            }),
            prisma.serviceRun.count({ where: { serviceId: service.id, status: `ok` } }),
            prisma.serviceRun.count({ where: { serviceId: service.id, status: `ok`, createdAt: { gte: new Date(at.getTime() - CANARY_QUIET_MS) } } }),
        ]);
        const verdict = watchVerdict(config, {
            status: service.status as ServiceStatus,
            recent: recent.map((run) => run.status),
            servedTotal,
        });
        if (verdict === `suspend`) {
            await prisma.service.update({ where: { id: service.id }, data: { status: `suspended`, suspendedFor: suspensionReason(config) } });
            logger.warn({ service: service.slug }, `pool: service suspended by the refund tripwire`);
            continue;
        }
        if (verdict === `graduate`) {
            await prisma.service.update({ where: { id: service.id }, data: { status: `listed` } });
            logger.info({ service: service.slug }, `pool: service graduated out of probation`);
        }
        // Real traffic already proved this one alive; spend nothing on a synthetic call.
        if (servedRecently > 0) {
            continue;
        }
        const shouldCanary = service.probedAt === null || at.getTime() - service.probedAt.getTime() >= CANARY_QUIET_MS;
        if (!shouldCanary) {
            continue;
        }
        const outcome = await probeService(service.upstreamUrl, decryptSecret(config, service.secret), service.sampleRequest, fetchFn, () => at, lookupFn);
        await prisma.serviceProbe.create({
            data: { serviceId: service.id, passed: outcome.passed, kind: `canary`, detail: JSON.stringify(outcome.checks) },
        });
        if (outcome.passed) {
            await prisma.service.update({ where: { id: service.id }, data: { probedAt: at, canaryFails: 0 } });
            continue;
        }
        const fails = service.canaryFails + 1;
        if (fails >= config.pool.canaryFailures) {
            await prisma.service.update({
                where: { id: service.id },
                data: {
                    status: `suspended`,
                    canaryFails: fails,
                    suspendedFor: `Suspended automatically after ${fails} failed health checks. ${probeFailure(outcome)} Fix it, run the probe, and publish again.`,
                },
            });
            logger.warn({ service: service.slug, fails }, `pool: service suspended by the canary`);
            continue;
        }
        await prisma.service.update({ where: { id: service.id }, data: { canaryFails: fails } });
        logger.info({ service: service.slug, fails }, `pool: canary probe failed`);
    }
};
