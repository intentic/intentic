import { CONNECT_TOKEN_HEADER } from "@intentic/api-contract";
import { pino } from "pino";
import { hostedWakeAlarmRoutes, HOSTED_WAKE_LEAD_MS, HOSTED_WAKE_RETRY_MS, runHostedWakeAlarms } from "./hosted-wake-alarm.js";
import { fakeWakeAlarms, hostedWakeConfig, wakeAlarmRow } from "./hosted-wake.testing.js";
import type { wakeHostedSandbox } from "./hosted-wake.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const logger = pino({ level: "silent" });
const wakeSpy = () => jest.fn(async (..._args: Parameters<typeof wakeHostedSandbox>): Promise<void> => {});

const postAlarm = (app: ReturnType<typeof hostedWakeAlarmRoutes>, at: unknown, token: string | null = "connect-s1") => {
    const headers = new Headers({ "content-type": "application/json" });
    if (token !== null) { headers.set(CONNECT_TOKEN_HEADER, token); }
    return app.request("/sandbox/wake-alarm", { method: "POST", headers, body: JSON.stringify({ at }) });
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

test("a new sweep wakes in deadline order at the exact lead and retains alarms until the ready daemon cancels", async () => {
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
    expect(wake.mock.calls.map(([, row]) => row.id)).toEqual(["late", "edge"]);
    expect(late.scheduledWakeRetryAt).toEqual(new Date(NOW + HOSTED_WAKE_RETRY_MS));
    expect(edge.scheduledWakeAt).toEqual(new Date(NOW + HOSTED_WAKE_LEAD_MS));
    // A second process reading the same durable rows must observe the claim, even without an in-memory timer.
    const restarted = { ...context, prisma: fakeWakeAlarms([late, edge]).prisma };
    await runHostedWakeAlarms(restarted, new Date(NOW + HOSTED_WAKE_RETRY_MS - 1), wake);
    expect(wake).toHaveBeenCalledTimes(2);
    const app = hostedWakeAlarmRoutes(context);
    expect((await postAlarm(app, null, "connect-late")).status).toBe(200);
    expect((await postAlarm(app, null, "connect-edge")).status).toBe(200);
    await runHostedWakeAlarms(restarted, new Date(NOW + HOSTED_WAKE_RETRY_MS), wake);
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
    expect(wake.mock.calls.map(([, row]) => row.id)).toEqual(["first", "next", "first", "next"]);
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
