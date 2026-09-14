import { PLATFORM_SITE_ORIGIN } from "@intentic/constants";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { DAY_MS } from "../../../durations.js";
import { JOB_HOSTED_ABUSE, runExclusive } from "../../../jobs-lock.js";
import { linkEmail, sendMail } from "../../../mail.js";
import { type MachineSample, queryMachineMetric } from "../fly/fly-metrics.js";
import { stopMachine } from "../fly/fly.js";
import { hostedEnabled } from "../hosted.js";
import { onHostedPlan } from "../hosted-plan.js";
import { closeHostedStretch } from "../hosted-usage.js";
import { suspendHosted } from "./hosted-standing.js";

/* THE ABUSE WATCH. The platform cannot see inside a hosted machine and does not try; what it can read is the
 * provider's own meter for the machine, from outside: how busy its CPUs were and how much it sent, averaged over
 * a window. A person's development work is bursty, a miner is flat out for as long as the machine is awake, and
 * the free lane pays for both. So a free machine that stays at or above `hosted.abuseCpuShare` of its CPUs (or
 * `hosted.abuseEgressGbPerHour`) for a whole `hosted.abuseWindowMinutes` is stopped, its owner told, and a
 * strike written; the strike after `hosted.abuseStrikesToSuspend - 1` more within `hosted.abuseStrikeDays`
 * suspends the account's hosted lane (hosted-standing.ts). A subscriber's machine is never stopped by this
 * watch, only reported: a long job on a machine somebody pays for is theirs to run, and an operator reads the
 * report. A machine is judged only once its current awake stretch is at least a window long, so a build that
 * pins the CPUs for twenty minutes after a wake is never a strike. */

export type StrikeKind = `cpu` | `egress`;
export type StrikeAction = `stopped` | `suspended` | `reported`;

interface Reading {
    readonly kind: StrikeKind;
    readonly threshold: number;
    readonly samples: readonly MachineSample[];
}

// The reason written on the account when the watch suspends it; read back to the owner in every refusal.
export const ABUSE_SUSPENSION_REASON = `repeated full-load use of a free hosted machine`;

// Prometheus anchors a label regex whole; the prefix is a literal inside it.
const regexLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);

// Busy share of the machine's CPUs: non-idle centiseconds per second over the window, over 100 per CPU.
const cpuQuery = (config: Config): string =>
    `sum by (app, instance) (rate(fly_instance_cpu{app=~"${regexLiteral(config.hosted.appPrefix)}-.*", mode!="idle"}[${config.hosted.abuseWindowMinutes}m])) / ${100 * config.hosted.cpus}`;

// Bytes sent per second over the window, as GB per hour.
const egressQuery = (config: Config): string =>
    `sum by (app, instance) (rate(fly_instance_net_sent_bytes{app=~"${regexLiteral(config.hosted.appPrefix)}-.*"}[${config.hosted.abuseWindowMinutes}m])) * 3600 / 1e9`;

// The whole fleet in one query per rule; a rule at 0 is not asked.
const readFleet = async (config: Config): Promise<Reading[]> => {
    const rules: { kind: StrikeKind; threshold: number; promql: string }[] = [
        { kind: `cpu`, threshold: config.hosted.abuseCpuShare, promql: cpuQuery(config) },
        ...(config.hosted.abuseEgressGbPerHour > 0
            ? [{ kind: `egress` as const, threshold: config.hosted.abuseEgressGbPerHour, promql: egressQuery(config) }]
            : []),
    ];
    return Promise.all(
        rules.map(async (rule) => ({ kind: rule.kind, threshold: rule.threshold, samples: await queryMachineMetric(config.hosted, rule.promql) })),
    );
};

interface Candidate {
    readonly id: string;
    readonly appName: string;
    readonly machineId: string;
    readonly wokeAt: Date | null;
    readonly sandbox: { readonly id: string; readonly name: string; readonly ownerId: string; readonly owner: { readonly email: string } };
}

interface Verdict {
    readonly kind: StrikeKind;
    readonly measure: number;
}

// The first rule this machine's own sample exceeds; a builder in the same app has another machine id and is never it.
const verdictFor = (readings: readonly Reading[], machine: Candidate): Verdict | undefined => {
    for (const reading of readings) {
        const sample = reading.samples.find((candidate) => candidate.app === machine.appName && candidate.machineId === machine.machineId);
        if (sample !== undefined && sample.value >= reading.threshold) {
            return { kind: reading.kind, measure: sample.value };
        }
    }
    return undefined;
};

// What was measured, in the owner's units.
const measured = (config: Config, verdict: Verdict): string =>
    verdict.kind === `cpu`
        ? `running at ${Math.round(verdict.measure * 100)}% of its ${config.hosted.cpus} CPUs for the last ${config.hosted.abuseWindowMinutes} minutes`
        : `sending ${verdict.measure.toFixed(1)} GB an hour for the last ${config.hosted.abuseWindowMinutes} minutes`;

const strikeMail = (config: Config, sandboxName: string, verdict: Verdict, suspended: boolean) => {
    const policy = `${PLATFORM_SITE_ORIGIN}/acceptable-use/`;
    return suspended
        ? {
              subject: `Hosted sandboxes are switched off for your account`,
              html: linkEmail({
                  heading: `"${sandboxName}" was stopped again, and hosted sandboxes are now off for your account`,
                  body: `Our provider's meter showed this machine ${measured(config, verdict)}, and it is not the first time in ${config.hosted.abuseStrikeDays} days. A free hosted machine is for one person's development work, and sustained full load is against the acceptable use policy, so we have switched hosted sandboxes off for your account. Your account, your files and any sandbox on your own computer are unaffected. If we have this wrong, reply to this email and a person will look.`,
                  action: `Read the acceptable use policy`,
                  link: policy,
              }),
              link: policy,
          }
        : {
              subject: `Your hosted machine "${sandboxName}" was stopped`,
              html: linkEmail({
                  heading: `"${sandboxName}" was stopped for running flat out`,
                  body: `Our provider's meter showed this machine ${measured(config, verdict)}. A free hosted machine is for one person's development work, not sustained full load, and we stop one that runs that way; mining and similar workloads are against the acceptable use policy. If this was real work, a long build or a test run, open the sandbox and it starts again, nothing was lost. A repeat within ${config.hosted.abuseStrikeDays} days switches hosted sandboxes off for your account.`,
                  action: `Open the sandbox`,
                  link: config.webOrigin,
              }),
              link: config.webOrigin,
          };
};

// One machine over the line: report a subscriber's, stop a free one, suspend on the repeat. Answers what was done, or
// undefined when this window already earned its strike.
const strike = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    machine: Candidate,
    verdict: Verdict,
    now: Date,
): Promise<StrikeAction | undefined> => {
    const windowMs = config.hosted.abuseWindowMinutes * 60_000;
    const { ownerId } = machine.sandbox;
    // One strike per machine per window: the stop takes a while to land, and a reopened machine earns a fresh window.
    const recent = await prisma.hostedStrike.findFirst({
        where: { appName: machine.appName, createdAt: { gte: new Date(now.getTime() - windowMs) } },
        select: { id: true },
    });
    if (recent !== null) {
        return undefined;
    }
    const base = {
        userId: ownerId,
        appName: machine.appName,
        kind: verdict.kind,
        measure: verdict.measure,
        windowMinutes: config.hosted.abuseWindowMinutes,
        createdAt: now,
    };
    if (await onHostedPlan(prisma, config, ownerId)) {
        await prisma.hostedStrike.create({ data: { ...base, action: `reported` } });
        logger.warn({ app: machine.appName, ownerId, ...verdict }, `hosted abuse: a subscriber's machine is at full load; reported, not stopped`);
        return `reported`;
    }
    await stopMachine(config.hosted.flyApiToken, machine.appName, machine.machineId);
    await closeHostedStretch(prisma, machine, ownerId, now);
    const prior = await prisma.hostedStrike.count({
        where: {
            userId: ownerId,
            action: { in: [`stopped`, `suspended`] },
            createdAt: { gte: new Date(now.getTime() - config.hosted.abuseStrikeDays * DAY_MS) },
        },
    });
    const suspend = config.hosted.abuseStrikesToSuspend > 0 && prior + 1 >= config.hosted.abuseStrikesToSuspend;
    await prisma.hostedStrike.create({ data: { ...base, action: suspend ? `suspended` : `stopped` } });
    if (suspend) {
        await suspendHosted(prisma, config, logger, ownerId, ABUSE_SUSPENSION_REASON, now);
        logger.error({ app: machine.appName, ownerId, ...verdict, prior }, `hosted abuse: machine stopped and the account's hosted lane suspended`);
    } else {
        logger.warn({ app: machine.appName, ownerId, ...verdict, prior }, `hosted abuse: machine stopped, owner warned`);
    }
    await sendMail(config, logger, { to: machine.sandbox.owner.email, ...strikeMail(config, machine.sandbox.name, verdict, suspend) }).catch(
        (error: unknown) => logger.error({ err: error, ownerId }, `hosted abuse: the owner's email could not be sent`),
    );
    return suspend ? `suspended` : `stopped`;
};

// One pass: every machine awake for at least a window, against the fleet's readings. Sequential and best-effort; one
// machine's failure is logged and retried next tick.
export const sweepHostedAbuse = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: Date = new Date(),
): Promise<Record<StrikeAction, number>> => {
    const tally: Record<StrikeAction, number> = { stopped: 0, suspended: 0, reported: 0 };
    if (!hostedEnabled(config) || config.hosted.abuseMinutes === 0) {
        return tally;
    }
    const candidates = await prisma.hostedMachine.findMany({
        where: { wokeAt: { lte: new Date(now.getTime() - config.hosted.abuseWindowMinutes * 60_000) } },
        select: {
            id: true,
            appName: true,
            machineId: true,
            wokeAt: true,
            sandbox: { select: { id: true, name: true, ownerId: true, owner: { select: { email: true } } } },
        },
    });
    if (candidates.length === 0) {
        return tally;
    }
    const readings = await readFleet(config);
    for (const machine of candidates) {
        const verdict = verdictFor(readings, machine);
        if (verdict === undefined) {
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sweep, gentle on the API
        const action = await strike(prisma, config, logger, machine, verdict, now).catch((error: unknown) => {
            logger.error({ err: error, app: machine.appName }, `hosted abuse: acting on this machine failed; retried next tick`);
            return undefined;
        });
        if (action !== undefined) {
            tally[action] += 1;
        }
    }
    return tally;
};

export const startHostedAbuse = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    if (!hostedEnabled(config) || config.hosted.abuseMinutes === 0) {
        return;
    }
    const tick = (): void => {
        void runExclusive(config, JOB_HOSTED_ABUSE, async () => {
            const tally = await sweepHostedAbuse(prisma, config, logger);
            if (tally.stopped + tally.suspended + tally.reported > 0) {
                logger.warn(tally, `hosted abuse: tick acted on machines at full load`);
            }
        }).catch((error: unknown) => logger.error({ err: error }, `hosted abuse sweep failed`));
    };
    tick();
    setInterval(tick, config.hosted.abuseMinutes * 60 * 1000);
};
