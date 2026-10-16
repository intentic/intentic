import { type SetupReport, SetupReportSchema } from "@intentic/api-contract";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { DAY_MS, MINUTE_MS } from "../durations.js";
import { JOB_SETUP_FAILURE_MAIL, runExclusive } from "../jobs-lock.js";
import { escapeHtml, linkEmail, type Mail, sendMail } from "../mail.js";
import { hostedEnabled } from "./hosted/hosted.js";
import { setupLink } from "./setup-email.js";

/* TELLING SOMEBODY THAT THEIR SETUP STOPPED AFTER THEY LEFT (2026-10-12). A setup run on the owner's own computer
 * reports each stage, and any failure with its fix, to /setup/report, and the setup page shows it, but only to somebody
 * still looking at it. A run can outlive its audience: an install orphaned by an app restart posted its failure twenty
 * minutes after its owner had quit, and nobody ever told him. So a short sweep mails the owner once, with the one
 * thing to do, when a sandbox:
 * - holds a setup report whose `failed` is not empty, and that report is still the newest (a later stage or a later
 *   failure replaces it, and a claim or a fresh code clears it);
 * - has never connected (no announce: `lastSeenAt` and `daemonUrl` both empty);
 * - has heard nothing for SETUP_FAILURE_QUIET_MS since the failure, and the failure is under SETUP_FAILURE_MAX_AGE_MS
 *   old, so a first deploy or a sweep that was down mails nothing stale;
 * - has not been mailed about this same failure (`setupFailureEmailedFor`);
 * - belongs to an owner who has not evidently come back: no sign-in since the failure (a new session lands them on the
 *   page that shows it), and no other sandbox of theirs made or first brought up since (they moved on, to our servers
 *   or another machine). Both are one count each on columns the platform already keeps; a page left open is not
 *   presence, so its polling is not read.
 * Runs every SWEEP_EVERY_MS under an advisory lock (jobs-lock.ts) rather than from the report's arrival: everything it
 * decides on lives in the row, so a restart or a second replica loses and repeats nothing. The platform keeps no
 * mail preference to respect; this is one mail about the owner's own setup, never a series. */

export const SETUP_FAILURE_QUIET_MS = 10 * MINUTE_MS;
export const SETUP_FAILURE_MAX_AGE_MS = DAY_MS;
// Puts the mail within two minutes of the quiet period ending, at one small query a pass.
const SWEEP_EVERY_MS = 2 * MINUTE_MS;
// A failure's problem can carry a Docker log tail of up to 2000 characters; the mail stays short, and the setup page
// has the whole of it.
export const PROBLEM_CHARS = 600;
// The fix for a failure whose report carried none: retrying is the remedy for most of them, and Docker keeps the layers
// it already pulled, so a retry does not start the download over.
export const FALLBACK_REMEDY = `Open intentic and press "Set it up now" again. What already downloaded is kept, so it carries on from where it stopped.`;

// Where the run stopped, said as the subject finishes "Your intentic setup stopped at …".
const STOPPED_AT = {
    preflight: `the first checks`,
    "pulling-image": `the download`,
    "creating-tunnel": `connecting it to the internet`,
    "starting-sandbox": `starting the sandbox`,
    "starting-connector": `connecting it to the internet`,
    "waiting-health": `starting the sandbox`,
    verifying: `the final check`,
    done: `the final check`,
} as const satisfies Record<SetupReport[`stage`], string>;

// The columns the rule reads, as the sweep selects them.
export interface SetupFailureRow {
    readonly id: string;
    readonly name: string;
    readonly ownerId: string;
    readonly lastSeenAt: Date | null;
    readonly daemonUrl: string | null;
    readonly setupCodeClaimedAt: Date | null;
    readonly setupCodeExpiresAt: Date | null;
    readonly setupReport: unknown;
    readonly setupFailureEmailedFor: string | null;
}

type SetupFailureFirst = SetupReport[`failed`][number];

export type SetupFailureVerdict =
    | { readonly due: true; readonly report: SetupReport; readonly first: SetupFailureFirst; readonly key: string; readonly failedAt: Date }
    | { readonly due: false; readonly why: `connected` | `no-failure` | `recent` | `stale` | `claimed-since` | `already-mailed` };

/* WHICH FAILURE THIS IS: the run it happened in and the checks that failed. The run is the claim that started it (or,
 * for a report sent without one, the code it ran under, whose expiry every mint stamps afresh). Not the report's own
 * `at`: two runs on one claim, which is what an app restart beside an orphaned install makes, would each post the same
 * failure at a different moment, and the owner would get it twice. The next claim is a new run, and its failure a new
 * mail. */
export const setupFailureKey = (row: Pick<SetupFailureRow, `setupCodeClaimedAt` | `setupCodeExpiresAt`>, report: SetupReport): string => {
    const run = (row.setupCodeClaimedAt ?? row.setupCodeExpiresAt)?.toISOString() ?? report.at;
    return `${run} ${report.failed.map((failure) => failure.check).join(`,`)}`.slice(0, 1000);
};

/** Whether the row's newest setup report is a failure its owner is owed a mail about, judged from the row alone. Pure. */
export const setupFailureVerdict = (row: SetupFailureRow, now: Date): SetupFailureVerdict => {
    if (row.lastSeenAt !== null || row.daemonUrl !== null) {
        return { due: false, why: `connected` };
    }
    const parsed = SetupReportSchema.safeParse(row.setupReport);
    const first = parsed.success ? parsed.data.failed[0] : undefined;
    const failedAt = parsed.success ? Date.parse(parsed.data.at) : Number.NaN;
    if (!parsed.success || first === undefined || Number.isNaN(failedAt)) {
        return { due: false, why: `no-failure` };
    }
    const quiet = now.getTime() - failedAt;
    if (quiet < SETUP_FAILURE_QUIET_MS) {
        return { due: false, why: `recent` };
    }
    if (quiet > SETUP_FAILURE_MAX_AGE_MS) {
        return { due: false, why: `stale` };
    }
    // A claim clears the report, so this only holds for a report from an older run landing after a newer claim.
    if (row.setupCodeClaimedAt !== null && row.setupCodeClaimedAt.getTime() > failedAt) {
        return { due: false, why: `claimed-since` };
    }
    const key = setupFailureKey(row, parsed.data);
    if (row.setupFailureEmailedFor === key) {
        return { due: false, why: `already-mailed` };
    }
    return { due: true, report: parsed.data, first, key, failedAt: new Date(failedAt) };
};

/** Whether the owner has evidently come back since `since`: signed in again, or made or brought up another sandbox. */
export const ownerBackSince = async (prisma: PrismaClient, row: Pick<SetupFailureRow, `id` | `ownerId`>, since: Date): Promise<boolean> => {
    const [signIns, sandboxes] = await Promise.all([
        prisma.session.count({ where: { userId: row.ownerId, createdAt: { gt: since } } }),
        // firstAnnouncedAt, not lastSeenAt: a sandbox already running elsewhere announces every hour, which says nothing
        // about where its owner is.
        prisma.sandbox.count({
            where: { ownerId: row.ownerId, id: { not: row.id }, OR: [{ createdAt: { gt: since } }, { firstAnnouncedAt: { gt: since } }] },
        }),
    ]);
    return signIns + sandboxes > 0;
};

// Clipped on a character, with the cut marked, so a log tail reads as cut rather than as finished.
const clip = (text: string, max: number): string => {
    const chars = [...text];
    return chars.length <= max ? text : `${chars.slice(0, max - 1).join(``)}…`;
};

export interface SetupFailureMailInput {
    readonly sandboxId: string;
    readonly sandboxName: string;
    readonly report: SetupReport;
    readonly first: SetupFailureFirst;
    // Whether this platform can start the sandbox on its own machines for this owner right now.
    readonly offerHosted: boolean;
}

const LABEL = `color: #1a1a1a; font-weight: 600; margin: 1.25rem 0 0.35rem;`;
const TEXT = `color: #555; line-height: 1.5; margin: 0; white-space: pre-wrap;`;

/** The mail: what stopped, the report's own fix (or the generic retry), the way back to the setup page, and the
 * hosted alternative where there is one. Pure. */
export const setupFailureMail = (config: Config, input: SetupFailureMailInput): Omit<Mail, `to`> => {
    const link = setupLink(config, input.sandboxId);
    const stoppedAt = STOPPED_AT[input.report.stage];
    const remedy = input.first.remedy.trim() === `` ? FALLBACK_REMEDY : input.first.remedy.trim();
    const others = input.report.failed.length - 1;
    const more = others > 0 ? ` The setup page lists ${others === 1 ? `one more thing` : `${others} more things`} it found.` : ``;
    const name = escapeHtml(input.sandboxName);
    const details = `
        <p style="${LABEL}">What stopped it</p>
        <p style="${TEXT} background: #f5f5f7; padding: 0.6rem 0.8rem; border-radius: 0.5rem; font-size: 0.9rem;">${escapeHtml(clip(input.first.problem.trim(), PROBLEM_CHARS))}</p>
        <p style="${LABEL}">What to do</p>
        <p style="${TEXT}">${escapeHtml(remedy)}${more}</p>`;
    // Opens the same sandbox with our servers already picked (the setup page's `?machine=`), so nothing is redone.
    const aside = input.offerHosted
        ? `
        <p style="color: #555; line-height: 1.5;">Or start instantly on our servers, with nothing to download: <a href="${link}&amp;machine=hosted" style="color: #4f46e5;">start "${name}" on our servers</a>.</p>`
        : ``;
    return {
        subject: `Your intentic setup stopped at ${stoppedAt}`,
        link,
        html: linkEmail({
            heading: `"${name}" is not set up yet`,
            body: `Setting it up on your computer stopped at ${stoppedAt}, and nothing has happened since. Here is what went wrong and what to do.`,
            details,
            action: `Open setup`,
            link,
            aside,
        }),
    };
};

/** One pass: mails every owner the rule says is owed one, and stamps each row so the same failure is never mailed
 * again. One row's failure is logged and tried again on the next pass. */
export const mailUnwatchedSetupFailures = async (
    prisma: PrismaClient,
    config: Config,
    logger: Logger,
    now: Date = new Date(),
): Promise<{ mailed: number }> => {
    const rows = await prisma.sandbox.findMany({
        where: {
            setupReport: { not: Prisma.DbNull },
            lastSeenAt: null,
            daemonUrl: null,
            // A machine of ours reports its own state; this is about a computer of the owner's.
            hosted: { is: null },
            // Storing a report updates the row, so a row untouched for longer holds no failure young enough to mail.
            updatedAt: { gt: new Date(now.getTime() - SETUP_FAILURE_MAX_AGE_MS) },
        },
        select: {
            id: true,
            name: true,
            ownerId: true,
            lastSeenAt: true,
            daemonUrl: true,
            setupCodeClaimedAt: true,
            setupCodeExpiresAt: true,
            setupReport: true,
            setupFailureEmailedFor: true,
            owner: { select: { email: true, hostedSuspendedAt: true } },
        },
    });
    let mailed = 0;
    for (const row of rows) {
        const verdict = setupFailureVerdict(row, now);
        if (!verdict.due) {
            continue;
        }
        try {
            // sequential: a handful of rows, each its own mail
            if (await ownerBackSince(prisma, row, verdict.failedAt)) {
                continue;
            }
            const mail = setupFailureMail(config, {
                sandboxId: row.id,
                sandboxName: row.name,
                report: verdict.report,
                first: verdict.first,
                offerHosted: hostedEnabled(config) && row.owner.hostedSuspendedAt === null,
            });
            // Mail first, stamp second: a stamp before a failed send would silently burn the one mail.
            // sequential, as above
            const delivery = await sendMail(config, logger, { to: row.owner.email, ...mail });
            // sequential, as above
            await prisma.sandbox.update({ where: { id: row.id }, data: { setupFailureEmailedAt: now, setupFailureEmailedFor: verdict.key } });
            logger.info({ sandboxId: row.id, stage: verdict.report.stage, check: verdict.first.check, delivery }, `setup failure: owner mailed`);
            mailed += 1;
        } catch (error) {
            logger.error({ err: error, sandboxId: row.id }, `setup failure: mailing the owner failed; tried again on the next pass`);
        }
    }
    return { mailed };
};

// Boot wiring (main.ts): a pass at start and every SWEEP_EVERY_MS, one replica at a time.
export const startSetupFailureMail = (prisma: PrismaClient, config: Config, logger: Logger): void => {
    const tick = (): void => {
        void runExclusive(config, JOB_SETUP_FAILURE_MAIL, async () => {
            await mailUnwatchedSetupFailures(prisma, config, logger);
        }).catch((error) => logger.error({ err: error }, `setup failure mail lock failed`));
    };
    tick();
    setInterval(tick, SWEEP_EVERY_MS);
};
