import { CONNECT_TOKEN_HEADER } from "@intentic/api-contract";
import { ORPCError } from "@orpc/server";
import { pino } from "pino";
import {
    HOSTED_WAKE_BOOT_MS,
    HOSTED_WAKE_GIVE_UP_MS,
    HOSTED_WAKE_LEAD_MS,
    HOSTED_WAKE_RETRY_MS,
    hostedWakeAlarmRoutes,
    runHostedWakeAlarms,
} from "./hosted-wake-alarm.js";
import { fakeWakeAlarms, hostedWakeConfig, wakeAlarmRow } from "./hosted-wake.testing.js";
import type { wakeHostedSandbox } from "./hosted-wake.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const logger = pino({ level: "silent" });
const wakeSpy = () => jest.fn(async (..._args: Parameters<typeof wakeHostedSandbox>): Promise<void> => {});

const postAlarm = (app: ReturnType<typeof hostedWakeAlarmRoutes>, at: unknown, token: string | null = "connect-s1", personAt?: number) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (token !== null) { headers.set(CONNECT_TOKEN_HEADER, token); }
    return app.request("/sandbox/wake-alarm", { method: "POST", headers, body: JSON.stringify(personAt === undefined ? { at } : { at, personAt }) });
};

test("a connect token saves, replaces and cancels only its own hosted alarm", async () => {
    const own = wakeAlarmRow(null);
    const other = wakeAlarmRow(NOW, "s2");
    const { prisma, table } = fakeWakeAlarms([own, other]);
    const app = hostedWakeAlarmRoutes({ prisma, config: hostedWakeConfig() });
    expect(await (await postAlarm(app, NOW + 3_600_000)).json()).toEqual({ ok: true });
    expect(own.scheduledWakeAt).toEqual(new Date(NOW + 3_600_000));
    own.scheduledWakeRetryAt = new Date(NOW);
    expect((await postAlarm(app, NOW + 600_000)).status).toBe(200);
    expect(own.scheduledWakeAt).toEqual(new Date(NOW + 600_000));
    expect(own.scheduledWakeRetryAt).toBeNull();
    expect((await postAlarm(app, null)).status).toBe(200);
    expect(own.scheduledWakeAt).toBeNull();
    expect(other.scheduledWakeAt).toEqual(new Date(NOW));
    expect(table.updateMany).toHaveBeenCalledTimes(3);
});

test.each([null, "wrong-token"])("a missing or unknown token cannot change an alarm (%s)", async (token) => {
    const own = wakeAlarmRow(NOW);
    const { prisma } = fakeWakeAlarms([own]);
    const app = hostedWakeAlarmRoutes({ prisma, config: hostedWakeConfig() });
    const response = await postAlarm(app, null, token);
    expect(response.status).toBe(token === null ? 400 : 404);
    expect(own.scheduledWakeAt).toEqual(new Date(NOW));
});

test.each([undefined, 0, -1, 1.5, "tomorrow", 8_640_000_000_000_001])("an invalid alarm is refused (%s)", async (at) => {
    const { prisma, table } = fakeWakeAlarms([wakeAlarmRow(null)]);
    expect((await postAlarm(hostedWakeAlarmRoutes({ prisma, config: hostedWakeConfig() }), at)).status).toBe(400);
    expect(table.updateMany).not.toHaveBeenCalled();
});

test.each(["removed", "local"])("a %s sandbox cannot register a hosted alarm", async (kind) => {
    const row = wakeAlarmRow(null);
    if (kind === "removed") { row.removedAt = new Date(NOW); } else { row.hosted = null; }
    const { prisma } = fakeWakeAlarms([row]);
    expect((await postAlarm(hostedWakeAlarmRoutes({ prisma, config: hostedWakeConfig() }), NOW)).status).toBe(404);
    expect(row.scheduledWakeAt).toBeNull();
});

test("hosted disabled refuses a new promise but still allows cancellation", async () => {
    const config = hostedWakeConfig();
    config.hosted.flyApiToken = "";
    const row = wakeAlarmRow(NOW);
    const { prisma } = fakeWakeAlarms([row]);
    const app = hostedWakeAlarmRoutes({ prisma, config });
    expect((await postAlarm(app, NOW + 60_000)).status).toBe(503);
    expect(row.scheduledWakeAt).toEqual(new Date(NOW));
    expect((await postAlarm(app, null)).status).toBe(200);
    expect(row.scheduledWakeAt).toBeNull();
});

test("a new sweep wakes in deadline order at the exact lead and retains alarms until the ready daemon retracts them", async () => {
    const late = wakeAlarmRow(NOW - 60_000, "late");
    const edge = wakeAlarmRow(NOW + HOSTED_WAKE_LEAD_MS, "edge");
    const future = wakeAlarmRow(NOW + HOSTED_WAKE_LEAD_MS + 1, "future");
    const cancelled = wakeAlarmRow(null, "cancelled");
    const removed = { ...wakeAlarmRow(NOW, "removed"), removedAt: new Date(NOW) };
    const local = { ...wakeAlarmRow(NOW, "local"), hosted: null };
    const { prisma } = fakeWakeAlarms([edge, future, cancelled, removed, local, late]);
    const context = { prisma, config: hostedWakeConfig(), logger };
    const wake = wakeSpy();
    await runHostedWakeAlarms(context, new Date(NOW), wake);
    expect(wake.mock.calls.map(([, row, cause]) => [row.id, cause])).toEqual([["late", "alarm"], ["edge", "alarm"]]);
    // Started, so its daemon has a boot's time to retract the alarm before the sweep starts it again.
    expect(late.scheduledWakeRetryAt).toEqual(new Date(NOW + HOSTED_WAKE_BOOT_MS));
    expect(edge.scheduledWakeAt).toEqual(new Date(NOW + HOSTED_WAKE_LEAD_MS));
    // A second process reading the same durable rows must observe the claim, even without an in-memory timer.
    const restarted = { ...context, prisma: fakeWakeAlarms([late, edge]).prisma };
    await runHostedWakeAlarms(restarted, new Date(NOW + HOSTED_WAKE_BOOT_MS - 1), wake);
    expect(wake).toHaveBeenCalledTimes(2);
    const app = hostedWakeAlarmRoutes(context);
    expect((await postAlarm(app, null, "connect-late")).status).toBe(200);
    expect((await postAlarm(app, null, "connect-edge")).status).toBe(200);
    await runHostedWakeAlarms(restarted, new Date(NOW + HOSTED_WAKE_BOOT_MS), wake);
    expect(wake).toHaveBeenCalledTimes(2);
});

test("a failed start keeps its promise, retries at the boundary, and does not block the next sandbox", async () => {
    const first = wakeAlarmRow(NOW, "first");
    const next = wakeAlarmRow(NOW, "next");
    const { prisma } = fakeWakeAlarms([first, next]);
    const context = { prisma, config: hostedWakeConfig(), logger };
    const wake = wakeSpy().mockRejectedValueOnce(new Error("provider unavailable"));
    await runHostedWakeAlarms(context, new Date(NOW), wake);
    expect(wake.mock.calls.map(([, row]) => row.id)).toEqual(["first", "next"]);
    expect(first.scheduledWakeAt).toEqual(new Date(NOW));
    expect(first.scheduledWakeRetryAt).toEqual(new Date(NOW + HOSTED_WAKE_RETRY_MS));
    await runHostedWakeAlarms(context, new Date(NOW + HOSTED_WAKE_RETRY_MS - 1), wake);
    expect(wake).toHaveBeenCalledTimes(2);
    await runHostedWakeAlarms(context, new Date(NOW + HOSTED_WAKE_RETRY_MS), wake);
    // `next` started, so it waits out its boot rather than being started again a minute later.
    expect(wake.mock.calls.map(([, row]) => row.id)).toEqual(["first", "next", "first"]);
});

test("a start that keeps failing backs off with how overdue its deadline is", async () => {
    const row = wakeAlarmRow(NOW - 10 * 60_000);
    const { prisma } = fakeWakeAlarms([row]);
    const wake = wakeSpy().mockRejectedValue(new Error("provider unavailable"));
    await runHostedWakeAlarms({ prisma, config: hostedWakeConfig(), logger }, new Date(NOW), wake);
    expect(row.scheduledWakeRetryAt).toEqual(new Date(NOW + 10 * 60_000));
    expect(row.scheduledWakeAt).toEqual(new Date(NOW - 10 * 60_000));
});

test.each([
    ["a suspended owner", new ORPCError("FORBIDDEN", { message: "suspended" })],
    ["spent hours", new ORPCError("PAYMENT_REQUIRED", { status: 402, message: "hours used up" })],
    ["a machine that is gone", new ORPCError("NOT_FOUND", { message: "no machine" })],
] as const)("%s drops the alarm instead of retrying it every minute", async (_case, refusal) => {
    const row = wakeAlarmRow(NOW);
    const { prisma } = fakeWakeAlarms([row]);
    const context = { prisma, config: hostedWakeConfig(), logger };
    const wake = wakeSpy().mockRejectedValue(refusal);
    await runHostedWakeAlarms(context, new Date(NOW), wake);
    expect(row.scheduledWakeAt).toBeNull();
    expect(row.scheduledWakeRetryAt).toBeNull();
    await runHostedWakeAlarms(context, new Date(NOW + HOSTED_WAKE_RETRY_MS), wake);
    expect(wake).toHaveBeenCalledTimes(1);
});

test("a promise a day overdue is left to the next start's catch-up rather than retried", async () => {
    const row = { ...wakeAlarmRow(NOW - HOSTED_WAKE_GIVE_UP_MS - 1), scheduledWakeRetryAt: new Date(NOW) };
    const { prisma } = fakeWakeAlarms([row]);
    const wake = wakeSpy();
    await runHostedWakeAlarms({ prisma, config: hostedWakeConfig(), logger }, new Date(NOW), wake);
    expect(wake).not.toHaveBeenCalled();
    expect(row.scheduledWakeAt).toBeNull();
});

test("alarms that keep failing cannot hold a fresh one behind them", async () => {
    const stuck = Array.from({ length: 64 }, (_, index) => ({
        ...wakeAlarmRow(NOW - 60 * 60_000, `stuck-${String(index)}`),
        scheduledWakeRetryAt: new Date(NOW - 1),
    }));
    const fresh = wakeAlarmRow(NOW, "fresh");
    const { prisma } = fakeWakeAlarms([...stuck, fresh]);
    const wake = wakeSpy();
    await runHostedWakeAlarms({ prisma, config: hostedWakeConfig(), logger }, new Date(NOW), wake);
    expect(wake.mock.calls[0]?.[1].id).toBe("fresh");
});

test("the daemon's word on when a person was last there is kept, and never later than now", async () => {
    const row = wakeAlarmRow(null);
    const { prisma } = fakeWakeAlarms([row]);
    const app = hostedWakeAlarmRoutes({ prisma, config: hostedWakeConfig() });
    expect((await postAlarm(app, NOW + 3_600_000, "connect-s1", 0)).status).toBe(200);
    expect(row.personSeenAt).toBeNull();
    expect((await postAlarm(app, null, "connect-s1", NOW - 60_000)).status).toBe(200);
    expect(row.personSeenAt).toEqual(new Date(NOW - 60_000));
    const future = Date.now() + 3_600_000;
    expect((await postAlarm(app, null, "connect-s1", future)).status).toBe(200);
    expect(row.personSeenAt!.getTime()).toBeLessThan(future);
});

test.each([null, NOW + 3_600_000])("a cancellation or reschedule between selection and claim wins (%s)", async (at) => {
    const row = wakeAlarmRow(NOW);
    const { prisma, table } = fakeWakeAlarms([row]);
    const context = { prisma, config: hostedWakeConfig(), logger };
    const select = table.findMany.getMockImplementation()!;
    table.findMany.mockImplementationOnce(async (args) => {
        const selected = await select(args);
        expect((await postAlarm(hostedWakeAlarmRoutes(context), at)).status).toBe(200);
        return selected;
    });
    const wake = wakeSpy();
    await runHostedWakeAlarms(context, new Date(NOW), wake);
    expect(wake).not.toHaveBeenCalled();
    expect(row.scheduledWakeAt).toEqual(at === null ? null : new Date(at));
    expect(row.scheduledWakeRetryAt).toBeNull();
});

test("concurrent sweep snapshots claim a deadline only once", async () => {
    const row = wakeAlarmRow(NOW);
    const { prisma } = fakeWakeAlarms([row]);
    const context = { prisma, config: hostedWakeConfig(), logger };
    const wake = wakeSpy();
    await Promise.all([runHostedWakeAlarms(context, new Date(NOW), wake), runHostedWakeAlarms(context, new Date(NOW), wake)]);
    expect(wake).toHaveBeenCalledTimes(1);
});

test.each(["removed", "released"])("a machine %s after selection is not started from an obsolete snapshot", async (change) => {
    const row = wakeAlarmRow(NOW);
    const { prisma, table } = fakeWakeAlarms([row]);
    const context = { prisma, config: hostedWakeConfig(), logger };
    const select = table.findMany.getMockImplementation()!;
    table.findMany.mockImplementationOnce(async (args) => {
        const selected = await select(args);
        if (change === "removed") { row.removedAt = new Date(NOW); } else { row.hosted = null; }
        return selected;
    });
    const wake = wakeSpy();
    await runHostedWakeAlarms(context, new Date(NOW), wake);
    expect(wake).not.toHaveBeenCalled();
    expect(row.scheduledWakeRetryAt).toBeNull();
});
