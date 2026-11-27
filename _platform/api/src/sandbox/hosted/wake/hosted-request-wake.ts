import { type RequestWakeAnswer, type RequestWakeBodySchema, type WakeDoor, WakeDoorSchema, wakeDoorCovers } from "@intentic/api-contract";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../../../config.js";
import { ingressServer } from "../../../ingress.js";
import { sameToken } from "../../edge-certificate.js";
import { hostedEnabled } from "../hosted.js";
import { HOSTED_WAKE_BOOT_MS, hostedWakeAlarmRoutes } from "./hosted-wake-alarm.js";
import { type HostedWakeContext, type HostedWakeSandbox, wakeHostedSandbox } from "./hosted-wake.js";

/* A REQUEST AT A WAKE DOOR (2026-11-27). A hosted machine sleeps with no tunnel, and the edge replays nothing, so before
 * this a webhook or a Slack or Telegram event that arrived while it slept was lost unless its sender retried until a
 * person happened to wake it. Before it sleeps, the daemon names its wake doors (a public path prefix and the SHA-256 of
 * a secret the request carries) with the alarm it saves (hosted-wake-alarm.ts). The edge, missing a tunnel for a plain
 * request, asks here with the request's path and the digests of what it carries, and answers the sender 503 with
 * Retry-After when this says a start is under way (ingress wakes.rs). A matched request starts the machine through the
 * alarm's own path (`wakeHostedSandbox`, cause "request": standing, spent hours, the state gate and metering, and never
 * counted as a person, so `personSeenAt` stays where it was), unawaited, so the edge is answered at once.
 *
 * What bounds it: one start while one boots (`requestWakeAt`, cleared by the daemon's first word, else after a boot's
 * time), and HOSTED_REQUEST_WAKES_PER_DAY starts a UTC day; each costs at most a boot and the alarm's five-minute grace
 * (sandbox idle-stop.ts). A sender that never retries still loses what it sent while the machine slept: this answers
 * the retry. Rejected: holding the sender's request open through the boot, which would tie a socket on the edge and a
 * Fly start to every stranger's request. */

// Starts a sandbox's doors may make in one UTC day: about forty-eight boots and graces of some six minutes, under five
// awake hours, so a leaked door cannot spend more than that of a month's hours in a day.
export const HOSTED_REQUEST_WAKES_PER_DAY = 48;
// What the edge tells the sender: a stopped machine starts in seconds, but its daemon boots and its netd dials the tunnel
// before a retry can land. Half the alarm's two-minute boot lead (HOSTED_WAKE_LEAD_MS), the platform's ceiling for that.
export const HOSTED_REQUEST_RETRY_AFTER_S = 60;

type RequestWakeBody = z.output<typeof RequestWakeBodySchema>;
const StoredDoorsSchema = z.array(WakeDoorSchema);

// The doors a row holds, or none when it holds nothing readable.
const storedDoors = (value: Prisma.JsonValue | undefined): readonly WakeDoor[] => {
    const parsed = StoredDoorsSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
};

const utcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const NO_DOORS: RequestWakeAnswer = { waking: false, listening: false };
const NOT_A_DOOR: RequestWakeAnswer = { waking: false, listening: true };
const WAKING: RequestWakeAnswer = { waking: true, listening: true, retryAfter: HOSTED_REQUEST_RETRY_AFTER_S };

export interface RequestWakeOutcome {
    readonly answer: RequestWakeAnswer;
    // The start this ask made, settled once the wake is done or failed; the route never awaits it.
    readonly started?: Promise<void>;
}

// A hosted sandbox as a start reads it, by its tunnel id (the edge's word) or its own (2026-11-27, a sleep watch's).
export const findRequestWakeSandbox = (prisma: PrismaClient, by: { readonly tunnelId: string } | { readonly id: string }) =>
    prisma.sandbox.findFirst({
        where: { ...by, removedAt: null, hosted: { isNot: null } },
        include: { hosted: true, owner: { select: { email: true } } },
    });

// The row a start claims against: the sandbox with its machine, and the request wakes it has made.
export type RequestWakeRow = HostedWakeSandbox & {
    readonly requestWakeAt: Date | null;
    readonly requestWakeDay: Date | null;
    readonly requestWakeCount: number;
};

// What claiming a start came to: one already booting, today's starts spent, or a start begun, which settles with what
// stopped it (undefined once the machine is starting).
export type RequestStart =
    | { readonly kind: "booting" }
    | { readonly kind: "spent" }
    | { readonly kind: "started"; readonly started: Promise<Error | undefined> };

// One start for something addressed to a sleeping machine, a request at a door or (2026-11-27) a message a sleep watch
// heard: none while one boots, at most HOSTED_REQUEST_WAKES_PER_DAY a UTC day, and claimed conditionally on the row as
// read, so two askers at once start it once. `what` is said in the log.
export const claimRequestStart = async (
    context: HostedWakeContext,
    sandbox: RequestWakeRow,
    now: Date,
    what: string,
    wake: typeof wakeHostedSandbox = wakeHostedSandbox,
): Promise<RequestStart> => {
    const booting = new Date(now.getTime() - HOSTED_WAKE_BOOT_MS);
    if (sandbox.requestWakeAt !== null && sandbox.requestWakeAt > booting) {
        return { kind: "booting" };
    }
    const today = utcDay(now);
    const sameDay = sandbox.requestWakeDay?.getTime() === today.getTime();
    if (sameDay && sandbox.requestWakeCount >= HOSTED_REQUEST_WAKES_PER_DAY) {
        context.logger.warn({ sandboxId: sandbox.id, what }, "hosted request wake: today's starts are spent; left to its sender");
        return { kind: "spent" };
    }
    const claimed = await context.prisma.sandbox.updateMany({
        where: {
            id: sandbox.id,
            removedAt: null,
            requestWakeDay: sandbox.requestWakeDay,
            requestWakeCount: sandbox.requestWakeCount,
            OR: [{ requestWakeAt: null }, { requestWakeAt: { lte: booting } }],
        },
        data: { requestWakeAt: now, requestWakeDay: today, requestWakeCount: sameDay ? sandbox.requestWakeCount + 1 : 1 },
    });
    // Another ask claimed it between the read and now: its start is the one under way.
    if (claimed.count === 0) {
        return { kind: "booting" };
    }
    context.logger.info({ sandboxId: sandbox.id, what }, "hosted request wake: starts the machine");
    return { kind: "started", started: start(context, sandbox, now, wake) };
};

// One ask from the edge: no doors, no matching door, a boot already under way, today's starts spent, or a start claimed
// and begun.
export const requestWake = async (
    context: HostedWakeContext,
    ask: RequestWakeBody,
    now = new Date(),
    wake: typeof wakeHostedSandbox = wakeHostedSandbox,
): Promise<RequestWakeOutcome> => {
    const sandbox = await findRequestWakeSandbox(context.prisma, { tunnelId: ask.sandboxId });
    const doors = storedDoors(sandbox?.wakeDoors);
    if (sandbox === null || sandbox.hosted === null || doors.length === 0) {
        return { answer: NO_DOORS };
    }
    const carried = new Set(ask.digests);
    if (!doors.some((door) => carried.has(door.digest) && wakeDoorCovers(door, ask.path))) {
        return { answer: NOT_A_DOOR };
    }
    const claimed = await claimRequestStart(context, { ...sandbox, hosted: sandbox.hosted }, now, `a request at ${ask.path}`, wake);
    switch (claimed.kind) {
        case "booting":
            return { answer: WAKING };
        case "spent":
            return { answer: NOT_A_DOOR };
        case "started":
            return { answer: WAKING, started: claimed.started.then(() => undefined) };
    }
};

// The claimed start, run to its end. One that did not happen is no boot to wait out, so the next request may try again;
// the day's count keeps it. Settles with what stopped it, for a caller that tells a refusal from a stumble.
const start = async (context: HostedWakeContext, sandbox: HostedWakeSandbox, claimedAt: Date, wake: typeof wakeHostedSandbox): Promise<Error | undefined> => {
    try {
        await wake(context, sandbox, "request");
        return undefined;
    } catch (error) {
        context.logger.warn({ err: error, sandboxId: sandbox.id }, "hosted request wake: the start did not complete; the next request may try again");
        await context.prisma.sandbox
            .updateMany({ where: { id: sandbox.id, requestWakeAt: claimedAt }, data: { requestWakeAt: null } })
            .catch((failure: Error) => context.logger.warn({ err: failure, sandboxId: sandbox.id }, "hosted request wake: the failed start could not be released"));
        return error instanceof Error ? error : new Error(String(error));
    }
};

// Whether the caller presented the edge's platform token; none configured admits nobody.
const presentsPlatformToken = (config: Config, authorization: string | undefined): boolean => {
    const presented = authorization?.startsWith(`Bearer `) === true ? authorization.slice(`Bearer `.length) : ``;
    return config.ingress.platformToken !== `` && sameToken(presented, config.ingress.platformToken);
};

const hostedRequestWakeRoutes = ({
    prisma,
    config,
    logger,
    wake = wakeHostedSandbox,
}: {
    readonly prisma: PrismaClient;
    readonly config: Config;
    readonly logger: Logger;
    readonly wake?: typeof wakeHostedSandbox;
}) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    ingressServer(app)("requestWake", async (c, kit) => {
        if (!presentsPlatformToken(config, c.req.header(`authorization`))) {
            return kit.refuse(401, `an edge presents the platform token`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `expected a sandbox id, a path and the digests the request carries`);
        }
        if (!hostedEnabled(config)) {
            return kit.answer(NO_DOORS);
        }
        return kit.answer((await requestWake({ prisma, config, logger }, body, new Date(), wake)).answer);
    });
    return app;
};

// Every hosted-wake route a machine calls: the daemon's alarm and doors, and the edge's ask.
export const hostedWakeRoutes = (deps: { readonly prisma: PrismaClient; readonly config: Config; readonly logger: Logger }) =>
    new Hono<{ Variables: { logger: Logger } }>().route(`/`, hostedWakeAlarmRoutes(deps)).route(`/`, hostedRequestWakeRoutes(deps));
