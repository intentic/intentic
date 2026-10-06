import { EventEmitter } from "node:events";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { version } from "../../version.js";

// Each platform call's outcome comes off a queue: `{ status, body }` answers with that code and body, `{ err: true }`
// simulates a transport failure, `{ hang: true }` accepts the connection and never answers (the socket's idle timeout,
// armed by the exchange, is a fake timer here). Every call's path and body are kept, in order.
const outcomes: Array<{ status?: number; body?: string; err?: boolean; hang?: boolean }> = [];
const calls: Array<{ path: string; body: unknown }> = [];
type FakeRequest = EventEmitter & {
    end: (payload?: string) => void;
    setTimeout: (ms: number, onIdle: () => void) => FakeRequest;
    destroy: (error: Error) => void;
};
// The response is an emitter like the real one: the exchange reads its body to the end before it answers.
const requestMock = jest.fn((url: URL, _opts: unknown, cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
    const req = new EventEmitter() as FakeRequest;
    let idle: { ms: number; onIdle: () => void } | undefined;
    req.setTimeout = (ms, onIdle) => {
        idle = { ms, onIdle };
        return req;
    };
    req.destroy = (error) => req.emit("error", error);
    req.end = (payload) => {
        calls.push({ path: url.pathname, body: payload === undefined ? undefined : JSON.parse(payload) });
        const outcome = outcomes.shift() ?? { status: 200 };
        if (outcome.err === true) {
            req.emit("error", new Error("boom"));
            return;
        }
        if (outcome.hang === true) {
            const armed = idle;
            if (armed !== undefined) {
                setTimeout(armed.onIdle, armed.ms);
            }
            return;
        }
        const res = Object.assign(new EventEmitter(), { statusCode: outcome.status ?? 200, headers: {} });
        cb(res);
        if (outcome.body !== undefined) {
            res.emit("data", Buffer.from(outcome.body));
        }
        res.emit("end");
    };
    return req;
});
jest.mock("node:https", () => ({ request: (...args: unknown[]) => requestMock(...(args as Parameters<typeof requestMock>)) }));

const { createAnnouncer, HEARTBEAT_MS } = await import("./announce.js");

const config = {
    platform: { url: "https://host.docker.internal:6480" },
    sandbox: { publicUrl: "https://sandbox-x.intentic.dev", grant: "ig1.grant" },
    connectToken: "tok",
} as unknown as Parameters<typeof createAnnouncer>[0];
const logger = { info: jest.fn(), warn: jest.fn() } as unknown as Parameters<typeof createAnnouncer>[1];

beforeEach(() => {
    jest.useFakeTimers();
    outcomes.length = 0;
    calls.length = 0;
    requestMock.mockClear();
});
afterEach(() => jest.useRealTimers());

// Request fires synchronously; the verdict lands a few microtasks later (the exchange is awaited), so this drains before
// reading status().
const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- draining microtasks one turn at a time is the point
        await Promise.resolve();
    }
};

const failForever = (outcome: { err?: boolean; status?: number }): void => {
    for (let i = 0; i < 500; i++) {
        outcomes.push(outcome);
    }
};

describe("createAnnouncer", () => {
    it("announces this build's version beside the address it is reached at, and which copy it is", () => {
        outcomes.push({ status: 200 });
        createAnnouncer(config, logger).start();
        expect(calls).toEqual([
            { path: "/sandbox/announce", body: { daemonUrl: "https://sandbox-x.intentic.dev", version, instance: expect.any(String) } },
        ]);
    });

    /* WHICH COPY (2026-10-05): one id for this process's life, or netd's for the container's; and where it runs. */
    describe("which copy it is", () => {
        afterEach(() => {
            delete process.env["INTENTIC_INSTANCE"];
            delete process.env["HOST_ENV"];
        });

        it("names the same instance on every announce of this process, its heartbeats included", async () => {
            createAnnouncer(config, logger).start();
            await advanceTimersByTimeAsync(HEARTBEAT_MS * 1.2);
            const named = calls.map((call) => (call.body as { instance: string }).instance);
            expect(named).toHaveLength(2);
            expect(new Set(named).size).toBe(1);
        });

        it("names the container's instance when netd sets one, and the machine and side it runs on", () => {
            process.env["INTENTIC_INSTANCE"] = "netd-7f3a";
            process.env["HOST_ENV"] = "Ubuntu";
            createAnnouncer({ ...config, hostLabel: "rog", hostPlatform: "linux" } as typeof config, logger).start();
            expect(calls[0]?.body).toMatchObject({ instance: "netd-7f3a", host: "rog", os: "Ubuntu" });
        });

        it("names the platform `ic` stamped as its side when no environment is set, and leaves out what is unknown", () => {
            createAnnouncer({ ...config, hostLabel: "", hostPlatform: "windows" } as typeof config, logger).start();
            expect(calls[0]?.body).not.toHaveProperty("host");
            expect(calls[0]?.body).toMatchObject({ os: "windows" });
        });
    });

    /* THE HEARTBEAT (2026-10-05). Registered, it announces again about once an hour, so the platform's `lastSeenAt`
     * says the sandbox ran recently rather than when it first registered. */
    describe("heartbeat", () => {
        it("is silent for the better part of an hour after a 200, then announces again", async () => {
            createAnnouncer(config, logger).start();
            expect(requestMock).toHaveBeenCalledTimes(1);
            await advanceTimersByTimeAsync(HEARTBEAT_MS * 0.85);
            expect(requestMock).toHaveBeenCalledTimes(1);
            await advanceTimersByTimeAsync(HEARTBEAT_MS * 0.3);
            expect(requestMock).toHaveBeenCalledTimes(2);
        });

        it("logs a heartbeat that lands only when it is news", async () => {
            const info = jest.fn();
            createAnnouncer(config, { info, warn: jest.fn() } as unknown as Parameters<typeof createAnnouncer>[1]).start();
            await advanceTimersByTimeAsync(HEARTBEAT_MS * 2.5);
            expect(requestMock.mock.calls.length).toBeGreaterThanOrEqual(3);
            expect(info).toHaveBeenCalledTimes(1);
        });

        it("ends for good on a deletion record, as a registration does", async () => {
            outcomes.push({ status: 200 }, { status: 410 });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await advanceTimersByTimeAsync(HEARTBEAT_MS * 1.2);
            expect(announcer.status()).toMatchObject({ state: "rejected", reason: "deleted", retrying: false });
            await advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
            expect(requestMock).toHaveBeenCalledTimes(2);
        });

        it("goes back to asking from the shortest wait when the platform has forgotten the sandbox", async () => {
            // No jitter, so the heartbeat lands on the hour exactly.
            const random = jest.spyOn(Math, "random").mockReturnValue(0.5);
            outcomes.push({ status: 200 }, { status: 404 }, { status: 200 });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await advanceTimersByTimeAsync(HEARTBEAT_MS);
            expect(announcer.status()).toMatchObject({ state: "rejected", reason: "unknown", retrying: true });
            await advanceTimersByTimeAsync(2_000);
            expect(announcer.status().state).toBe("registered");
            expect(requestMock).toHaveBeenCalledTimes(3);
            random.mockRestore();
        });
    });

    it("retries a failed attempt with backoff, then waits for its heartbeat the moment it's acked", async () => {
        outcomes.push({ err: true }, { status: 200 });
        createAnnouncer(config, logger).start();
        expect(requestMock).toHaveBeenCalledTimes(1);

        // First retry backs off 2s, then acks and never fires again.
        await advanceTimersByTimeAsync(2_000);
        expect(requestMock).toHaveBeenCalledTimes(2);
        await advanceTimersByTimeAsync(120_000);
        expect(requestMock).toHaveBeenCalledTimes(2);
    });

    // A platform that is down, or that forgot this sandbox, comes back on its own time: the daemon never stops asking,
    // only slows to one attempt every five minutes once the first ten have passed.
    it("keeps asking a platform it cannot reach, five minutes apart after the fast window", async () => {
        failForever({ err: true });
        createAnnouncer(config, logger).start();
        await advanceTimersByTimeAsync(30 * 60_000);
        const at30 = requestMock.mock.calls.length;
        await advanceTimersByTimeAsync(5 * 60_000);
        expect(requestMock.mock.calls.length - at30).toBe(1);
        await advanceTimersByTimeAsync(5 * 60_000);
        expect(requestMock.mock.calls.length - at30).toBe(2);
    });

    it("cuts a platform that accepts the connection and never answers, and asks again", async () => {
        outcomes.push({ hang: true }, { status: 200 });
        const announcer = createAnnouncer(config, logger);
        announcer.start();
        await advanceTimersByTimeAsync(60_000);
        expect(announcer.status()).toMatchObject({ state: "unreachable", retrying: true });
        await advanceTimersByTimeAsync(2_000);
        expect(announcer.status().state).toBe("registered");
    });

    // status() is what /health serves and ic's postflight/doctor read; each verdict below is a sentence a user actually
    // sees.
    describe("status", () => {
        it("is off until started: a headless run has nothing to register with", () => {
            expect(createAnnouncer(config, logger).status()).toEqual({ state: "off" });
        });

        it("reports registered after the ack, with the identity of the database that took it", async () => {
            outcomes.push({ status: 200, body: `{"ok":true,"identity":"a0028692-7cf2-4ef4-8429-86a98d60be8a"}` });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await settle();
            expect(announcer.status()).toEqual({ state: "registered", identity: "a0028692-7cf2-4ef4-8429-86a98d60be8a", at: Date.now() });
        });

        it("reports registered without an identity from a platform too old to send one", async () => {
            outcomes.push({ status: 200, body: `{"ok":true}` });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await settle();
            expect(announcer.status()).toEqual({ state: "registered", at: Date.now() });
        });

        it("names a rejection with the platform's answer, still retrying", async () => {
            outcomes.push({ status: 409 }, { status: 200 });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await settle();
            expect(announcer.status()).toEqual({
                state: "rejected",
                retrying: true,
                detail: "the platform answered HTTP 409 to this sandbox's registration",
                at: Date.now(),
            });
            // Retry succeeds; the verdict moves from rejected to registered.
            await advanceTimersByTimeAsync(2_000);
            expect(announcer.status().state).toBe("registered");
        });

        it("names a platform with no record of the sandbox, and keeps asking", async () => {
            failForever({ status: 404 });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await settle();
            expect(announcer.status()).toEqual({
                state: "rejected",
                reason: "unknown",
                retrying: true,
                detail: "the platform has no record of this sandbox: if it lost track of it, open the app and press Reconnect",
                at: Date.now(),
            });
            // Every 2, 4, 8 and 16 seconds, then every 30 to the ten-minute mark (24 attempts), then 30s, 60s, 120s and
            // 240s apart on the way to the five-minute cap: 28 by the twentieth minute.
            await advanceTimersByTimeAsync(20 * 60_000);
            expect(requestMock).toHaveBeenCalledTimes(28);
        });

        it("stops at a deletion record, saying so: the one answer that ends the retrying", async () => {
            failForever({ status: 410 });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await settle();
            expect(announcer.status()).toEqual({
                state: "rejected",
                reason: "deleted",
                retrying: false,
                detail: "the platform says this sandbox was deleted: restore it from the trash in the app, or set up a new one",
                at: Date.now(),
            });
            await advanceTimersByTimeAsync(30 * 60_000);
            expect(requestMock).toHaveBeenCalledTimes(1);
        });

        it("stays retrying, with the last failure's why, long after the fast window", async () => {
            failForever({ err: true });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await advanceTimersByTimeAsync(20 * 60_000);
            expect(announcer.status()).toMatchObject({
                state: "unreachable",
                detail: "the platform could not be reached from inside the sandbox: boom",
                retrying: true,
            });
        });
    });

    // The owner's Reconnect (POST /platform/relink).
    describe("relink", () => {
        const adoption = { ticket: "at1.ticket", owner: "owner@example.com", name: "intentic", image: undefined };

        it("does nothing on a sandbox with no platform to register with", async () => {
            expect(await createAnnouncer(config, logger).relink()).toEqual({ announce: { state: "off" } });
            expect(requestMock).not.toHaveBeenCalled();
        });

        it("registers now, without waiting out the backoff", async () => {
            failForever({ err: true });
            const announcer = createAnnouncer(config, logger);
            announcer.start();
            await advanceTimersByTimeAsync(20 * 60_000);
            outcomes.length = 0;
            outcomes.push({ status: 200 });
            expect(await announcer.relink()).toEqual({ announce: { state: "registered", at: Date.now() } });
            expect(announcer.status().state).toBe("registered");
        });

        it("has a platform with no record of the sandbox adopt it, then registers", async () => {
            const announcer = createAnnouncer(config, logger);
            failForever({ status: 404 });
            announcer.start();
            await settle();
            outcomes.length = 0;
            outcomes.push(
                { status: 404 },
                { status: 200, body: `{"ok":true,"sandboxId":"adopted"}` },
                { status: 200, body: `{"ok":true,"identity":"id-2"}` },
            );
            calls.length = 0;
            expect(await announcer.relink(adoption)).toEqual({
                announce: { state: "registered", identity: "id-2", at: Date.now() },
                adoption: { status: 200, detail: "adopted" },
            });
            expect(calls.map((call) => call.path)).toEqual(["/sandbox/announce", "/sandbox/adopt", "/sandbox/announce"]);
            expect(calls[1]?.body).toEqual({
                ticket: "at1.ticket",
                grant: "ig1.grant",
                daemonUrl: "https://sandbox-x.intentic.dev",
                owner: "owner@example.com",
                version,
                name: "intentic",
            });
        });

        it("passes on the platform's refusal of the adoption, and keeps the registration's verdict", async () => {
            const announcer = createAnnouncer(config, logger);
            failForever({ status: 404 });
            announcer.start();
            await settle();
            outcomes.length = 0;
            outcomes.push(
                { status: 404 },
                { status: 410, body: "error: this sandbox was deleted from intentic: restore it from the trash, or set up a new one" },
            );
            failForever({ status: 404 });
            const answer = await announcer.relink(adoption);
            expect(answer.adoption).toEqual({
                status: 410,
                detail: "this sandbox was deleted from intentic: restore it from the trash, or set up a new one",
            });
            expect(answer.announce).toMatchObject({ state: "rejected", reason: "unknown", retrying: true });
        });

        it("asks for no adoption when the platform knows the sandbox after all", async () => {
            const announcer = createAnnouncer(config, logger);
            outcomes.push({ status: 404 });
            announcer.start();
            await settle();
            outcomes.length = 0;
            outcomes.push({ status: 200 });
            calls.length = 0;
            expect(await announcer.relink(adoption)).toEqual({ announce: { state: "registered", at: Date.now() } });
            expect(calls.map((call) => call.path)).toEqual(["/sandbox/announce"]);
        });
    });
});
