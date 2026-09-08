import type { AdminCosts } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../config.js";
import { trialEnabled } from "../trial/trial-pool.js";
import { DAY_MS } from "../durations.js";

// Hosted machines/pool (Fly) and the trial meter (Google keys): the two places the platform spends real money on users'
// behalf. Figures are computed against the config knobs they are spent under, so the panel renders promise vs. actual.

const TOP_OWNERS = 10;

const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

// The `YYYY-MM` key hosted-usage.ts bills by.
const utcMonthOf = (at: Date): string => at.toISOString().slice(0, 7);

export const adminCosts = async (prisma: PrismaClient, config: Config, now: () => Date = () => new Date()): Promise<AdminCosts> => {
    const at = now();
    const month = utcMonthOf(at);
    const today = utcDayOf(at);
    // The 7 UTC day keys ending today; TrialUsage/CreditSpend are keyed by these strings, not timestamps.
    const week = Array.from({ length: 7 }, (_, index) => utcDayOf(new Date(at.getTime() - (6 - index) * DAY_MS)));

    const [machines, awakeOrUncounted, idleWarned, monthAggregate, topSpenders, poolMachines, todayAggregate, weekRows] = await Promise.all([
        prisma.hostedMachine.count(),
        prisma.hostedMachine.count({ where: { wokeAt: { not: null } } }),
        prisma.hostedMachine.count({ where: { idleWarnedAt: { not: null } } }),
        prisma.hostedUsage.aggregate({ where: { month }, _sum: { minutes: true } }),
        prisma.hostedUsage.findMany({ where: { month }, orderBy: { minutes: `desc` }, take: TOP_OWNERS, select: { minutes: true, userId: true } }),
        // The whole pool: bounded by regions × poolSize plus strays, so reading the rows beats three group-bys.
        prisma.hostedPoolMachine.findMany({ select: { region: true, state: true, image: true } }),
        prisma.trialUsage.aggregate({ where: { day: today }, _sum: { messages: true }, _count: { _all: true } }),
        // A row per (user, day): bounded by trial users × 7, carrying what the distinct counts and model mix need.
        prisma.trialUsage.findMany({ where: { day: { in: week } }, select: { userId: true, messages: true, lastModel: true } }),
    ]);

    // Names for the top spenders, one bounded lookup instead of a join on every row.
    const spenderUsers = await prisma.user.findMany({
        where: { id: { in: topSpenders.map((row) => row.userId) } },
        select: { id: true, email: true },
    });
    const emailOf = new Map(spenderUsers.map((user) => [user.id, user.email]));

    const poolByRegion = new Map<string, { building: number; ready: number; claimed: number; staleImage: number }>();
    for (const machine of poolMachines) {
        const region = poolByRegion.get(machine.region) ?? { building: 0, ready: 0, claimed: 0, staleImage: 0 };
        if (machine.state === `building` || machine.state === `ready` || machine.state === `claimed`) {
            region[machine.state] += 1;
        }
        if (machine.image !== config.hosted.image) {
            region.staleImage += 1;
        }
        poolByRegion.set(machine.region, region);
    }

    const weekUsers = new Set<string>();
    let weekMessages = 0;
    const modelUsers = new Map<string, Set<string>>();
    for (const row of weekRows) {
        weekUsers.add(row.userId);
        weekMessages += row.messages;
        if (row.lastModel !== null) {
            const users = modelUsers.get(row.lastModel) ?? new Set<string>();
            users.add(row.userId);
            modelUsers.set(row.lastModel, users);
        }
    }

    return {
        hosted: {
            machines,
            awakeOrUncounted,
            idleWarned,
            monthMinutes: monthAggregate._sum.minutes ?? 0,
            monthlyHoursCap: config.hosted.monthlyHours,
            // Rows cascade with the user; an unresolved email is a mid-read deletion race, dropped rather than
            // invented.
            topOwners: topSpenders.flatMap((row) => {
                const email = emailOf.get(row.userId);
                return email === undefined ? [] : [{ email, minutes: row.minutes }];
            }),
            pool: [...poolByRegion.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([region, counts]) => ({ region, ...counts })),
            poolSize: config.hosted.poolSize,
            image: config.hosted.image,
        },
        trial: {
            enabled: trialEnabled(config),
            dailyMessages: config.trial.dailyMessages,
            messagesToday: todayAggregate._sum.messages ?? 0,
            usersToday: todayAggregate._count._all,
            messages7d: weekMessages,
            users7d: weekUsers.size,
            models: [...modelUsers.entries()].map(([model, users]) => ({ model, accounts: users.size })).sort((a, b) => b.accounts - a.accounts),
        },
    };
};
