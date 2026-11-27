import { createHash } from "node:crypto";
import { CONNECT_TOKEN_HEADER } from "@intentic/api-contract";
import { ORPCError } from "@orpc/server";
import { pino } from "pino";
import { HOSTED_REQUEST_RETRY_AFTER_S, HOSTED_REQUEST_WAKES_PER_DAY, hostedWakeRoutes, requestWake } from "./hosted-request-wake.js";
import { HOSTED_WAKE_BOOT_MS } from "./hosted-wake-alarm.js";
import type { wakeHostedSandbox } from "./hosted-wake.js";
import { fakeWakeAlarms, hostedWakeConfig, type WakeAlarmRow, wakeAlarmRow } from "./hosted-wake.testing.js";

// A request at a wake door starts a sleeping hosted machine the way the alarm does, without counting as a person, at
// most once per boot and HOSTED_REQUEST_WAKES_PER_DAY times a UTC day; anything else changes nothing.

const NOW = new Date("2026-11-27T12:00:00Z");
const logger = pino({ level: "silent" });
const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const FIRE = "/automations/auto-1/fire";
const doored = (id = "s1"): WakeAlarmRow => ({ ...wakeAlarmRow(null, id), wakeDoors: [{ path: FIRE, digest: digest(`token-${id}`) }] });
const wakeSpy = () => jest.fn(async (..._args: Parameters<typeof wakeHostedSandbox>): Promise<void> => {});
const ask = (row: WakeAlarmRow, path = FIRE, secrets: readonly string[] = [`token-${row.id}`]) => ({
    sandboxId: row.tunnelId,
    path,
    digests: secrets.map(digest),
});

const setUp = (rows: WakeAlarmRow[]) => {
    const { prisma, table } = fakeWakeAlarms(rows);
    return { context: { prisma, config: hostedWakeConfig(), logger }, table };
};

test("a request carrying a door's secret under its path starts the machine as a request, never as a person", async () => {
    const row = doored();
    row.personSeenAt = new Date("2026-11-20T00:00:00Z");
    const { context } = setUp([row]);
    const wake = wakeSpy();
    const outcome = await requestWake(context, ask(row, `${FIRE}/extra`), NOW, wake);
    await outcome.started;
    expect(outcome.answer).toEqual({ waking: true, listening: true, retryAfter: HOSTED_REQUEST_RETRY_AFTER_S });
    expect(wake.mock.calls.map(([, sandbox, cause]) => [sandbox.id, cause])).toEqual([["s1", "request"]]);
    expect(row.requestWakeAt).toEqual(NOW);
    expect(row.requestWakeCount).toBe(1);
    expect(row.personSeenAt).toEqual(new Date("2026-11-20T00:00:00Z"));
});

test("a request no door covers, or one without the secret, changes nothing", async () => {
    const row = doored();
    const { context, table } = setUp([row]);
    const wake = wakeSpy();
    for (const asked of [ask(row, "/automations/auto-1/fireworks"), ask(row, "/health"), ask(row, FIRE, ["guessed"]), ask(row, FIRE, [])]) {
        expect((await requestWake(context, asked, NOW, wake)).answer).toEqual({ waking: false, listening: true });
    }
    expect(wake).not.toHaveBeenCalled();
    expect(table.updateMany).not.toHaveBeenCalled();
    expect(row.requestWakeAt).toBeNull();
});

test("a sandbox with no doors, one on somebody's own computer, or one removed is not listening", async () => {
    const bare = wakeAlarmRow(null, "bare");
    const local = { ...doored("local"), hosted: null };
    const removed = { ...doored("removed"), removedAt: NOW };
    const unreadable = { ...doored("odd"), wakeDoors: { path: FIRE } };
    const { context } = setUp([bare, local, removed, unreadable]);
    const wake = wakeSpy();
    for (const row of [bare, local, removed, unreadable]) {
        expect((await requestWake(context, ask(row), NOW, wake)).answer).toEqual({ waking: false, listening: false });
    }
    expect((await requestWake(context, { sandboxId: "000000000000", path: FIRE, digests: [] }, NOW, wake)).answer).toEqual({ waking: false, listening: false });
    expect(wake).not.toHaveBeenCalled();
});

test("no second start while one boots, and another once the daemon has spoken or a boot's time has passed", async () => {
    const row = doored();
    const { context } = setUp([row]);
    const wake = wakeSpy();
    await (await requestWake(context, ask(row), NOW, wake)).started;
    const again = await requestWake(context, ask(row), new Date(NOW.getTime() + HOSTED_WAKE_BOOT_MS - 1), wake);
    expect(again).toEqual({ answer: { waking: true, listening: true, retryAfter: HOSTED_REQUEST_RETRY_AFTER_S } });
    expect(wake).toHaveBeenCalledTimes(1);
    await (await requestWake(context, ask(row), new Date(NOW.getTime() + HOSTED_WAKE_BOOT_MS), wake)).started;
    expect(wake).toHaveBeenCalledTimes(2);
    expect(row.requestWakeCount).toBe(2);
});

test("two asks landing together start it once", async () => {
    const row = doored();
    const { context } = setUp([row]);
    const wake = wakeSpy();
    const both = await Promise.all([requestWake(context, ask(row), NOW, wake), requestWake(context, ask(row), NOW, wake)]);
    await Promise.all(both.map((outcome) => outcome.started));
    expect(both.map((outcome) => outcome.answer.waking)).toEqual([true, true]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(row.requestWakeCount).toBe(1);
});

test("a day's starts are capped, and the next UTC day starts counting again", async () => {
    const row = doored();
    row.requestWakeDay = new Date("2026-11-27T00:00:00Z");
    row.requestWakeCount = HOSTED_REQUEST_WAKES_PER_DAY - 1;
    const { context } = setUp([row]);
    const wake = wakeSpy();
    await (await requestWake(context, ask(row), NOW, wake)).started;
    expect(row.requestWakeCount).toBe(HOSTED_REQUEST_WAKES_PER_DAY);
    const spent = new Date(NOW.getTime() + HOSTED_WAKE_BOOT_MS);
    expect((await requestWake(context, ask(row), spent, wake)).answer).toEqual({ waking: false, listening: true });
    expect(wake).toHaveBeenCalledTimes(1);
    const tomorrow = new Date("2026-11-28T00:00:01Z");
    await (await requestWake(context, ask(row), tomorrow, wake)).started;
    expect(wake).toHaveBeenCalledTimes(2);
    expect([row.requestWakeDay, row.requestWakeCount]).toEqual([new Date("2026-11-28T00:00:00Z"), 1]);
});

test("a start that fails is no boot to wait out, and still counts against the day", async () => {
    const row = doored();
    const { context } = setUp([row]);
    const wake = wakeSpy().mockRejectedValueOnce(new ORPCError("PAYMENT_REQUIRED", { message: "hours spent" }));
    const outcome = await requestWake(context, ask(row), NOW, wake);
    await outcome.started;
    expect(outcome.answer.waking).toBe(true);
    expect([row.requestWakeAt, row.requestWakeCount]).toEqual([null, 1]);
    await (await requestWake(context, ask(row), new Date(NOW.getTime() + 1_000), wake)).started;
    expect(wake).toHaveBeenCalledTimes(2);
});

describe("the routes", () => {
    const edgeAsk = (app: ReturnType<typeof hostedWakeRoutes>, body: object, token: string | null = "test-platform-token") => {
        const headers = new Headers({ "content-type": "application/json" });
        if (token !== null) {
            headers.set("authorization", `Bearer ${token}`);
        }
        return app.request("/api/ingress/wake", { method: "POST", headers, body: JSON.stringify(body) });
    };

    const routes = (rows: WakeAlarmRow[]) => {
        const { prisma } = fakeWakeAlarms(rows);
        const config = hostedWakeConfig();
        config.ingress.platformToken = "test-platform-token";
        return hostedWakeRoutes({ prisma, config, logger });
    };

    test("only an edge presenting the platform token is answered, and a malformed ask is refused", async () => {
        const row = doored();
        const app = routes([row]);
        expect((await edgeAsk(app, ask(row), null)).status).toBe(401);
        expect((await edgeAsk(app, ask(row), "guess")).status).toBe(401);
        expect((await edgeAsk(app, { sandboxId: row.tunnelId, path: FIRE, digests: ["token-s1"] })).status).toBe(400);
        expect(row.requestWakeAt).toBeNull();
    });

    test("an unmatched ask is answered without a start", async () => {
        const row = doored();
        const response = await edgeAsk(routes([row]), ask(row, "/elsewhere"));
        expect([response.status, await response.json()]).toEqual([200, { waking: false, listening: true }]);
        expect(row.requestWakeAt).toBeNull();
    });

    test("the daemon's alarm saves its doors, its retraction clears them, and an older daemon's leaves them standing", async () => {
        const row = wakeAlarmRow(null);
        const app = routes([row]);
        const alarm = (body: object) =>
            app.request("/sandbox/wake-alarm", {
                method: "POST",
                headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: row.token },
                body: JSON.stringify(body),
            });
        const doors = [{ path: FIRE, digest: digest("token-s1") }];
        expect(await (await alarm({ at: null, personAt: 0, doors })).json()).toEqual({ ok: true });
        expect(row.wakeDoors).toEqual(doors);
        expect((await alarm({ at: null })).status).toBe(200);
        expect(row.wakeDoors).toEqual(doors);
        expect((await alarm({ at: null, doors: [] })).status).toBe(200);
        expect(row.wakeDoors).toEqual([]);
    });

    test("every alarm write lets go of what the sandbox let the platform hold while it slept", async () => {
        const row = wakeAlarmRow(null);
        const { prisma, sleepWatch } = fakeWakeAlarms([row]);
        const app = hostedWakeRoutes({ prisma, config: hostedWakeConfig(), logger });
        const response = await app.request("/sandbox/wake-alarm", {
            method: "POST",
            headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: row.token },
            body: JSON.stringify({ at: null, personAt: 0, doors: [] }),
        });
        expect(response.status).toBe(200);
        expect(sleepWatch.deleteMany).toHaveBeenCalledWith({ where: { sandboxId: row.id } });
    });

    test("the first word of a boot a request started says so, once, and ends the boot's hold", async () => {
        const row = doored();
        row.requestWakeAt = new Date(Date.now() - 30_000);
        const app = routes([row]);
        const retract = () =>
            app.request("/sandbox/wake-alarm", {
                method: "POST",
                headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: row.token },
                body: JSON.stringify({ at: null, personAt: 0, doors: [] }),
            });
        expect(await (await retract()).json()).toEqual({ ok: true, requestWake: true });
        expect(row.requestWakeAt).toBeNull();
        expect(await (await retract()).json()).toEqual({ ok: true });
    });
});
