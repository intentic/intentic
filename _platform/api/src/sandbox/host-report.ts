import { createHmac, timingSafeEqual } from "node:crypto";
import {
    HOST_REPORT_KEY_LABEL,
    type HostReport,
    type HostReportClaimed,
    HostReportClaimSchema,
    type HostReportInput,
    HostReportPostSchema,
    HostReportSchema,
} from "@intentic/api-contract";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";
import { bearerOf } from "../tokens/api-tokens.js";
import { mintSetupCode } from "./mint-sandbox.js";

/* WHAT THE MACHINE A SANDBOX RUNS ON FOUND, for the moments the browser cannot ask the sandbox itself. `ic sandbox fix`
 * diagnoses the machine and posts what it found here; the editor reads the latest off the owner's sandbox summary. The
 * platform never calls the machine. Two ways a run authenticates:
 *
 * - The report key, lowercase hex HMAC-SHA256 over HOST_REPORT_KEY_LABEL keyed with the connect token. `ic` derives it
 *   from the container's env, so the machine agent's own runs report with no code; the platform derives it from the
 *   token it keeps encrypted. It grants this one write and nothing else.
 * - A fix code the owner mints in the browser for the command the recovery panel hands out, redeemed at /claim for the
 *   sandbox's tunnel id and its report key. Only for a sandbox on a machine of the owner's own: a hosted one has
 *   hostedStatus. */

// As long as a setup code lives, for the same reason: long enough to re-run a pasted command, short enough to go stale.
export const FIX_CODE_TTL_MS = 30 * 60 * 1000;

// The shortest gap between two stored reports of one stage and outcome. `ic` posts on every check it finishes; the
// editor needs the stage moving and the verdict, not every tick of it.
export const HOST_REPORT_INTERVAL_MS = 2000;

export const hostReportKey = (connectToken: string): string => createHmac(`sha256`, connectToken).update(HOST_REPORT_KEY_LABEL).digest(`hex`);

// Undefined where the stored token cannot be decrypted (SECRETS_KEY missing or rotated): no key can be checked then.
const reportKeyOf = (config: Config, encryptedToken: string): string | undefined => {
    try {
        return hostReportKey(decryptSecret(config, encryptedToken));
    } catch (error) {
        console.warn("Could not derive the sandbox report key", error);
        return undefined;
    }
};

// timingSafeEqual throws on unequal lengths, and the expected key's length (64) is no secret.
const keysMatch = (presented: string, expected: string): boolean => {
    const given = Buffer.from(presented, `utf8`);
    const wanted = Buffer.from(expected, `utf8`);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/* ONE SLOT PER REPORTER (2026-10-05). A Windows PC with WSL runs a machine agent on each side, and both report on the
 * sandboxes they can see, so one slot meant each report overwrote the other's, and the throttle below, comparing a
 * report with whichever one was stored, skipped one side's word as a repeat of the other's. The column now holds the
 * newest report of each reporter (`reporterOf`: the machine, its OS and the environment on it), at most HOST_REPORTERS
 * of them, as `{ reporters: { <reporter>: report } }`; a row written before holds one bare report, read as a single
 * reporter. The summary still says the newest (`hostReport`) and adds them all (`hostReporters`). A read-modify-write
 * without a lock, like the rest of this route's writes: two reporters posting in the same instant can lose one report,
 * which that reporter's next post puts back. */
export const HOST_REPORTERS = 3;

const ReportersSchema = z.object({ reporters: z.record(z.string(), z.unknown()) });

// Who sent a report: the machine (case aside, since Windows spells its name in capitals and WSL does not), its OS, and
// the environment on it (a WSL distro's name).
export const reporterOf = (report: Pick<HostReportInput, `machine` | `os` | `env`>): string =>
    `${report.machine.toLowerCase()}|${report.os}|${report.env ?? ``}`;

// Every report the column holds, newest first; none for a row with none or one that no longer parses.
export const hostReportsOf = (stored: unknown): HostReport[] => {
    const single = HostReportSchema.safeParse(stored);
    if (single.success) {
        return [single.data];
    }
    const held = ReportersSchema.safeParse(stored);
    if (!held.success) {
        return [];
    }
    return Object.values(held.data.reporters)
        .flatMap((value) => {
            const parsed = HostReportSchema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
        })
        .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at));
};

// The newest report, as the contract states it, or null: what the owner's summary has always carried.
export const hostReportOf = (stored: unknown): HostReport | null => hostReportsOf(stored)[0] ?? null;

// The column once `report` lands: its reporter's slot replaced, and the newest HOST_REPORTERS reporters kept.
export const withHostReport = (stored: unknown, report: HostReport): Prisma.InputJsonValue => {
    const others = hostReportsOf(stored).filter((held) => reporterOf(held) !== reporterOf(report));
    return { reporters: Object.fromEntries([report, ...others].slice(0, HOST_REPORTERS).map((kept) => [reporterOf(kept), kept])) };
};

/* Whether `next` is skipped rather than stored: the same reporter's stored one is under HOST_REPORT_INTERVAL_MS old and
 * says the same stage and outcome. A change of either always lands, so `done` is never lost to the throttle. A stored
 * `at` from the future (another replica's clock) does not hold writes back. */
export const skipsWrite = (held: HostReport | null, next: HostReportInput, nowMs: number): boolean => {
    if (held === null || held.stage !== next.stage || held.outcome !== next.outcome) {
        return false;
    }
    const age = nowMs - Date.parse(held.at);
    return age >= 0 && age < HOST_REPORT_INTERVAL_MS;
};

// A fresh code, replacing whatever the row held. The setup code's generator: the same kind of code, pasted the same way.
export const mintFixCode = async (prisma: PrismaClient, sandboxId: string): Promise<{ code: string; expiresAt: string }> => {
    const code = mintSetupCode();
    const expiresAt = new Date(Date.now() + FIX_CODE_TTL_MS);
    await prisma.sandbox.update({ where: { id: sandboxId }, data: { fixCode: code, fixCodeExpiresAt: expiresAt } });
    return { code, expiresAt: expiresAt.toISOString() };
};

export interface HostReportDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
}

/* `POST /host-report/claim` and `POST /host-report`, mounted by app.ts beside the other routes machines call. Neither
 * is rate-limited: no route of this app is (the setup claim included), and a fix code carries the setup code's 65 bits
 * for half an hour. */
export const hostReportHttpRoutes = ({ config, prisma }: HostReportDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();

    // A live fix code buys its sandbox's tunnel id and report key. Re-claimable until it expires, since the owner may
    // run the command again; 404 for unknown, expired, removed and hosted alike.
    app.post(`/claim`, async (c) => {
        // allow(silent-catch): a body that is not JSON carries no code, which the parse below refuses.
        const body = HostReportClaimSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.text(`error: missing code`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({
            where: { fixCode: body.data.code },
            select: { id: true, tunnelId: true, token: true, fixCodeExpiresAt: true, removedAt: true, hosted: { select: { id: true } } },
        });
        const live = sandbox !== null && sandbox.fixCodeExpiresAt !== null && sandbox.fixCodeExpiresAt > new Date();
        if (!live || sandbox.removedAt !== null || sandbox.hosted !== null) {
            return c.text(`error: fix code invalid or expired`, 404);
        }
        const key = reportKeyOf(config, sandbox.token);
        if (key === undefined) {
            c.get(`logger`).error({ sandboxId: sandbox.id }, `host report claim: the sandbox's connect token could not be decrypted`);
            return c.text(`error: this sandbox's report key cannot be derived`, 500);
        }
        return c.json({ sandbox: sandbox.tunnelId, key } satisfies HostReportClaimed);
    });

    // The report itself, under the report key. 401 alike for an unknown sandbox and a wrong key (existence is public
    // anyway, at /api/reachability); 204 for a report stored and for one the throttle skipped, so `ic` never retries.
    app.post(`/`, async (c) => {
        const presented = bearerOf(c.req.header(`authorization`));
        if (presented === ``) {
            return c.text(`error: missing report key`, 401);
        }
        // allow(silent-catch): a body that is not JSON is a malformed report, which the parse below refuses.
        const body = HostReportPostSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.text(`error: malformed report`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({
            where: { tunnelId: body.data.sandbox },
            select: { id: true, token: true, tokenDigest: true, hostReport: true, hosted: { select: { id: true } } },
        });
        const expected = sandbox === null ? undefined : reportKeyOf(config, sandbox.token);
        if (sandbox === null || expected === undefined || !keysMatch(presented, expected)) {
            return c.text(`error: that report key is not this sandbox's`, 401);
        }
        if (sandbox.hosted !== null) {
            return c.text(`error: a sandbox intentic hosts has no host report`, 404);
        }
        const { report } = body.data;
        const held = hostReportsOf(sandbox.hostReport).find((stored) => reporterOf(stored) === reporterOf(report)) ?? null;
        if (skipsWrite(held, report, Date.now())) {
            return c.body(null, 204);
        }
        // Pinned to the token the key was checked against, as announce is: a token rotated since the read writes nothing.
        const written = await prisma.sandbox.updateMany({
            where: { id: sandbox.id, tokenDigest: sandbox.tokenDigest },
            data: { hostReport: withHostReport(sandbox.hostReport, { ...report, at: new Date().toISOString() }) },
        });
        return written.count === 0 ? c.text(`error: that report key is not this sandbox's`, 401) : c.body(null, 204);
    });

    return app;
};
