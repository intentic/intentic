import type { SetupReport } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { DAY_MS, MINUTE_MS } from "../durations.js";
import {
    FALLBACK_REMEDY,
    mailUnwatchedSetupFailures,
    ownerBackSince,
    PROBLEM_CHARS,
    setupFailureKey,
    setupFailureMail,
    setupFailureVerdict,
    type SetupFailureRow,
} from "./setup-failure-email.js";

const NOW = new Date(`2026-10-12T14:40:00.000Z`);
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE_MS);

// The incident's own report: the orphaned install's failure, posted twenty minutes after its owner quit, remedy empty.
const DOWNLOAD_PROBLEM = `ghcr.io/intentic/sandbox:stable did not finish downloading in 3 attempts. That is most often the network. Docker said: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.`;
const failedReport = (over: Partial<SetupReport> = {}): SetupReport => ({
    stage: `pulling-image`,
    failed: [{ check: `pull-image`, problem: DOWNLOAD_PROBLEM, remedy: `` }],
    at: minutesAgo(18).toISOString(),
    ...over,
});

const row = (over: Partial<SetupFailureRow> = {}): SetupFailureRow => ({
    id: `s1`,
    name: `My sandbox`,
    ownerId: `u1`,
    lastSeenAt: null,
    daemonUrl: null,
    setupCodeClaimedAt: minutesAgo(39),
    setupCodeExpiresAt: minutesAgo(9),
    setupReport: failedReport(),
    setupFailureEmailedFor: null,
    ...over,
});

// SAFETY: the sweep and sendMail log through these three methods and nothing else.
const logger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

// SAFETY: the module reads only these fields of the config: the web origin, Resend's pair, and what hostedEnabled reads.
const config = (): Config =>
    ({
        webOrigin: `https://app.test`,
        email: { apiKey: `re_test`, from: `intentic <no-reply@intentic.dev>` },
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: { flyApiToken: `fly`, flyOrg: `intentic` },
    }) as never;

afterEach(() => {
    unstubAllGlobals();
});

describe(`which setup failures earn their owner a mail`, () => {
    it(`a failure on a sandbox that never connected, quiet for ten minutes, is due`, () => {
        const verdict = setupFailureVerdict(row(), NOW);
        expect(verdict).toMatchObject({ due: true, failedAt: minutesAgo(18), first: { check: `pull-image` } });
    });

    it(`waits out the quiet period: a failure nine minutes old may still have somebody watching it`, () => {
        expect(setupFailureVerdict(row({ setupReport: failedReport({ at: minutesAgo(9).toISOString() }) }), NOW)).toEqual({ due: false, why: `recent` });
    });

    // A newer report replaces the failure on the row; whether it is a later stage or a later failure, the clock restarts.
    it(`a newer report means the run moved on: a later stage is no failure, a later failure starts the quiet again`, () => {
        const movedOn = row({ setupReport: { stage: `starting-sandbox`, failed: [], at: minutesAgo(12).toISOString() } });
        expect(setupFailureVerdict(movedOn, NOW)).toEqual({ due: false, why: `no-failure` });
        const failedAgain = row({ setupReport: failedReport({ at: minutesAgo(2).toISOString() }) });
        expect(setupFailureVerdict(failedAgain, NOW)).toEqual({ due: false, why: `recent` });
    });

    it(`a claim after the failure means somebody ran it again`, () => {
        expect(setupFailureVerdict(row({ setupCodeClaimedAt: minutesAgo(5) }), NOW)).toEqual({ due: false, why: `claimed-since` });
    });

    it(`is never due twice for the same failure`, () => {
        const once = row();
        const verdict = setupFailureVerdict(once, NOW);
        if (!verdict.due) {
            throw new Error(`expected the first verdict to be due`);
        }
        expect(setupFailureVerdict({ ...once, setupFailureEmailedFor: verdict.key }, NOW)).toEqual({ due: false, why: `already-mailed` });
    });

    // The incident's shape: an app restart started a second run beside the orphaned one, on the same claim.
    it(`two runs on one claim reporting the same failure are one failure; the next claim's failure is another`, () => {
        const claim = { setupCodeClaimedAt: minutesAgo(39), setupCodeExpiresAt: minutesAgo(9) };
        const early = setupFailureKey(claim, failedReport({ at: minutesAgo(30).toISOString() }));
        expect(setupFailureKey(claim, failedReport({ at: minutesAgo(15).toISOString() }))).toBe(early);
        expect(setupFailureKey({ ...claim, setupCodeClaimedAt: minutesAgo(14) }, failedReport())).not.toBe(early);
        // A different check failing in the same run is a different failure too.
        const other = failedReport({ failed: [{ check: `docker-running`, problem: `Docker is not running.`, remedy: `Start Docker Desktop.` }] });
        expect(setupFailureKey(claim, other)).not.toBe(early);
    });

    it(`a sandbox that ever connected is not asked about`, () => {
        expect(setupFailureVerdict(row({ lastSeenAt: minutesAgo(1) }), NOW)).toEqual({ due: false, why: `connected` });
        expect(setupFailureVerdict(row({ daemonUrl: `https://sandbox-abc.sbx.test` }), NOW)).toEqual({ due: false, why: `connected` });
    });

    it(`a failure older than a day is left alone, so a deploy or a sweep that was down mails nothing stale`, () => {
        const old = row({ setupReport: failedReport({ at: new Date(NOW.getTime() - DAY_MS - MINUTE_MS).toISOString() }) });
        expect(setupFailureVerdict(old, NOW)).toEqual({ due: false, why: `stale` });
    });

    it(`no report, or one that does not parse, is no failure`, () => {
        expect(setupFailureVerdict(row({ setupReport: null }), NOW)).toEqual({ due: false, why: `no-failure` });
        expect(setupFailureVerdict(row({ setupReport: { stage: `nope` } }), NOW)).toEqual({ due: false, why: `no-failure` });
    });
});

describe(`whether the owner came back`, () => {
    const counting = (sessions: number, sandboxes: number) => ({
        session: { count: jest.fn().mockResolvedValue(sessions) },
        sandbox: { count: jest.fn().mockResolvedValue(sandboxes) },
    });
    // SAFETY: the check calls only these two counts, each answering a number.
    const asPrisma = (fake: ReturnType<typeof counting>): PrismaClient => fake as never;

    it(`a sign-in or another sandbox since the failure says they did; neither says they did not`, async () => {
        const since = minutesAgo(18);
        const quiet = counting(0, 0);
        expect(await ownerBackSince(asPrisma(quiet), { id: `s1`, ownerId: `u1` }, since)).toBe(false);
        expect(quiet.session.count).toHaveBeenCalledWith({ where: { userId: `u1`, createdAt: { gt: since } } });
        // Another sandbox's hourly heartbeat says nothing about where its owner is; being made or first brought up does.
        expect(quiet.sandbox.count).toHaveBeenCalledWith({
            where: { ownerId: `u1`, id: { not: `s1` }, OR: [{ createdAt: { gt: since } }, { firstAnnouncedAt: { gt: since } }] },
        });
        expect(await ownerBackSince(asPrisma(counting(1, 0)), { id: `s1`, ownerId: `u1` }, since)).toBe(true);
        expect(await ownerBackSince(asPrisma(counting(0, 1)), { id: `s1`, ownerId: `u1` }, since)).toBe(true);
    });
});

describe(`the mail`, () => {
    const mailFor = (report: SetupReport, offerHosted = true, name = `My sandbox`) =>
        setupFailureMail(config(), { sandboxId: `s1`, sandboxName: name, report, first: report.failed[0]!, offerHosted });

    it(`says where it stopped, what stopped it, the generic retry when the report has no fix, and the way back`, () => {
        const mail = mailFor(failedReport());
        expect(mail.subject).toBe(`Your intentic setup stopped at the download`);
        expect(mail.link).toBe(`https://app.test/setup?sandbox=s1`);
        expect(mail.html).toContain(`did not finish downloading in 3 attempts`);
        expect(mail.html).toContain(FALLBACK_REMEDY.replaceAll(`"`, `&quot;`));
        expect(mail.html).toContain(`href="https://app.test/setup?sandbox=s1"`);
        expect(mail.html).toContain(`Or start instantly on our servers`);
        expect(mail.html).toContain(`href="https://app.test/setup?sandbox=s1&amp;machine=hosted"`);
        // No tracking: the existing frame has no pixel, and this one adds no image of its own.
        expect(mail.html).not.toContain(`<img`);
    });

    it(`carries the report's own fix when it has one, and names the stage it stopped at`, () => {
        const mail = mailFor(
            failedReport({
                stage: `preflight`,
                failed: [{ check: `docker-running`, problem: `Docker Desktop is not running.`, remedy: `Start Docker Desktop, then press "Set it up now" again.` }],
            }),
        );
        expect(mail.subject).toBe(`Your intentic setup stopped at the first checks`);
        expect(mail.html).toContain(`Start Docker Desktop, then press &quot;Set it up now&quot; again.`);
        expect(mail.html).not.toContain(`What already downloaded is kept`);
    });

    it(`leaves the hosted alternative out where this platform cannot offer it`, () => {
        const mail = mailFor(failedReport(), false);
        expect(mail.html).not.toContain(`our servers`);
        expect(mail.html).not.toContain(`machine=hosted`);
    });

    it(`treats the machine's words and the sandbox's name as text, and clips a long problem`, () => {
        const long = `<b>docker</b> said: ${`x`.repeat(2000)}`;
        const mail = mailFor(failedReport({ failed: [{ check: `pull-image`, problem: long, remedy: `` }] }), true, `<script>alert(1)</script>`);
        expect(mail.html).not.toContain(`<b>docker</b>`);
        expect(mail.html).toContain(`&lt;b&gt;docker&lt;/b&gt;`);
        expect(mail.html).not.toContain(`<script>`);
        expect(mail.html).toContain(`"&lt;script&gt;alert(1)&lt;/script&gt;" is not set up yet`);
        expect(mail.html).toContain(`${`x`.repeat(20)}…`);
        expect(mail.html).not.toContain(`x`.repeat(PROBLEM_CHARS));
    });

    it(`points at the setup page for anything past the first failure`, () => {
        const two = failedReport({
            failed: [
                { check: `pull-image`, problem: DOWNLOAD_PROBLEM, remedy: `` },
                { check: `disk-space`, problem: `Low on disk space.`, remedy: `Free some space.` },
            ],
        });
        expect(mailFor(two).html).toContain(`The setup page lists one more thing it found.`);
    });
});

describe(`the sweep`, () => {
    type Owned = SetupFailureRow & { owner: { email: string; hostedSuspendedAt: Date | null } };
    const owned = (over: Partial<SetupFailureRow> = {}): Owned => ({ ...row(over), owner: { email: `owner@example.test`, hostedSuspendedAt: null } });

    const fakePrisma = (rows: Owned[], back = { sessions: 0, sandboxes: 0 }) => ({
        sandbox: {
            findMany: jest.fn().mockResolvedValue(rows),
            count: jest.fn().mockResolvedValue(back.sandboxes),
            update: jest.fn().mockResolvedValue({}),
        },
        session: { count: jest.fn().mockResolvedValue(back.sessions) },
    });
    // SAFETY: the sweep calls only these delegates' methods, each answering what its call selects.
    const asPrisma = (fake: ReturnType<typeof fakePrisma>): PrismaClient => fake as never;

    // What reached Resend, one parsed body per mail.
    const stubResend = (status = 200): { to: string; subject: string; html: string }[] => {
        const sent: { to: string; subject: string; html: string }[] = [];
        stubGlobal(`fetch`, (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)));
            return Promise.resolve(new Response(`{}`, { status }));
        });
        return sent;
    };

    it(`mails the owner of a due failure once and stamps which failure it was, leaving the rest alone`, async () => {
        const sent = stubResend();
        const prisma = fakePrisma([owned({ id: `s1` }), owned({ id: `s2`, setupReport: failedReport({ at: minutesAgo(3).toISOString() }) })]);

        expect(await mailUnwatchedSetupFailures(asPrisma(prisma), config(), logger, NOW)).toEqual({ mailed: 1 });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ to: `owner@example.test`, subject: `Your intentic setup stopped at the download` });
        const due = setupFailureVerdict(row({ id: `s1` }), NOW);
        expect(prisma.sandbox.update).toHaveBeenCalledTimes(1);
        expect(prisma.sandbox.update).toHaveBeenCalledWith({
            where: { id: `s1` },
            data: { setupFailureEmailedAt: NOW, setupFailureEmailedFor: due.due ? due.key : `` },
        });
        // Only rows that never connected, of computers the owner owns, recent enough to matter, are read at all.
        expect(prisma.sandbox.findMany.mock.calls[0]?.[0]).toMatchObject({
            where: { lastSeenAt: null, daemonUrl: null, hosted: { is: null }, updatedAt: { gt: new Date(NOW.getTime() - DAY_MS) } },
        });
    });

    it(`does not mail an owner who signed in since the failure`, async () => {
        const sent = stubResend();
        const prisma = fakePrisma([owned()], { sessions: 1, sandboxes: 0 });
        expect(await mailUnwatchedSetupFailures(asPrisma(prisma), config(), logger, NOW)).toEqual({ mailed: 0 });
        expect(sent).toHaveLength(0);
        expect(prisma.sandbox.update).not.toHaveBeenCalled();
    });

    it(`does not stamp a mail that was not sent, so the next pass tries again`, async () => {
        stubResend(500);
        const prisma = fakePrisma([owned()]);
        expect(await mailUnwatchedSetupFailures(asPrisma(prisma), config(), logger, NOW)).toEqual({ mailed: 0 });
        expect(prisma.sandbox.update).not.toHaveBeenCalled();
    });

    it(`offers our servers only to an owner the hosted lane would take`, async () => {
        const sent = stubResend();
        const suspended = { ...owned(), owner: { email: `owner@example.test`, hostedSuspendedAt: minutesAgo(600) } };
        await mailUnwatchedSetupFailures(asPrisma(fakePrisma([suspended])), config(), logger, NOW);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.html).not.toContain(`machine=hosted`);
    });
});
